// Reusable client for observing the real LG ThinQ cloud's MQTT notification feed.
//
// This module deals only with an in-memory `State` object (just the country code and
// OAuth refresh token):
//   - login()  performs the one-time interactive sign-in and returns a State
//   - connect(state, ...) streams notifications using a State
//
// The AWS-IoT subscription (key/cert/clientId) is NOT part of State and is never
// persisted: it is generated at runtime. This is deliberate — the subscription pins
// an MQTT clientId, and AWS IoT drops any earlier connection using the same clientId,
// so sharing one across concurrently-running tools (the MCP server, lgcloud-monitor,
// rethink-capture) makes them fight. A fresh per-process subscription gives each its
// own clientId.
//
// Persisting/loading the State (where, in what file, how to validate) is the caller's
// responsibility — see ./state.ts. The module itself does no file I/O.

import readline from 'node:readline'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import mqtt from 'mqtt'
import * as OAuth2 from '@/bridge/oauth2'
import { subprocess } from '@/bridge/util'
import { Client, IOT_BASE_URL, RouteCertResponse, RouteResponse, apiFetch, signInUrl } from '@/bridge/thinqApi'

export type Subscription = { key: string; cert: string; subscriptions: string[] }
export type State = { countryCode: string; refreshToken: string }

type CertificateResponse = { certificatePem: string; subscriptions: string[] }

export type CloudMessage = { topic: string; payload: unknown | null; raw: string }
export type ConnectOptions = { onMessage: (msg: CloudMessage) => void; log?: (msg: string) => void }

// Interactive: print a sign-in URL, read the pasted post-login URL from stdin, exchange
// the code for a refresh token. Login flow inspired by 'wideq'.
async function oauth2Login(client: Client): Promise<string> {
    const base = await client.getUrls()
    console.log(`Use your browser to log in at ${signInUrl(base.webUrl, client.env.countryCode).toString()}`)

    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    let code = ''
    while (true) {
        const outUrl = await new Promise<string>((resolve) =>
            terminal.question('Paste the post-login URL here: ', resolve),
        )
        try {
            code = new URL(outUrl).searchParams.get('code') ?? ''
        } catch {}
        if (code) break
        console.log(`This URL doesn't look right. It should contain a code= parameter.`)
    }
    terminal.close()

    const { refreshToken } = await OAuth2.fromCode(base.authUrl, code)
    return refreshToken
}

async function generateSubscription(client: Client, log: (m: string) => void): Promise<Subscription> {
    log('dbg: generating RSA key pair')
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })

    // Write the key to a temp file: openssl req can't read from Node's socket-backed
    // stdin, and bash is not available in all container environments.
    const tmpKeyPath = join(tmpdir(), `rethink-lgcloud-${Date.now()}.pem`)
    writeFileSync(tmpKeyPath, privateKey as string, { mode: 0o600 })

    let csr: string
    try {
        log('dbg: generating CSR via openssl req')
        csr = await subprocess('openssl', [
            'req',
            '-new',
            '-key',
            tmpKeyPath,
            '-subj',
            '/CN=AWS IoT Certificate/O=Amazon',
        ])
        if (!csr.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
            throw new Error(`openssl req produced unexpected output: ${csr.slice(0, 120)}`)
        }
        log(`dbg: CSR generated (${csr.split('\n').length} lines)`)
    } finally {
        try {
            unlinkSync(tmpKeyPath)
        } catch {}
    }

    const { thinq2Uri } = await client.gateway
    log(`dbg: requesting certificate from LG (${thinq2Uri})`)
    const response = await apiFetch<CertificateResponse>(`${thinq2Uri}/service/users/client/certificate`, {
        headers: client.headers,
        method: 'POST',
        body: JSON.stringify({ csr }),
    })
    if (typeof response?.certificatePem !== 'string') throw new Error('Invalid certificate returned')

    log(
        `dbg: certificate received (${response.certificatePem.split('\n').length} lines), ${response.subscriptions.length} subscription topic(s)`,
    )
    for (const t of response.subscriptions) log(`dbg: topic: ${t}`)

    return {
        key: privateKey as string,
        cert: response.certificatePem,
        subscriptions: response.subscriptions,
    }
}

async function openMQTT(client: Client, subscription: Subscription, opts: ConnectOptions): Promise<mqtt.MqttClient> {
    const log = opts.log ?? (() => {})

    const [route, { certificatePem: caCert }] = await Promise.all([
        apiFetch<RouteResponse>(`${IOT_BASE_URL}/route`, {
            headers: { 'x-country-code': client.env.countryCode, 'x-service-phase': 'OP', accept: 'application/json' },
        }),
        apiFetch<RouteCertResponse>(`${IOT_BASE_URL}/route/certificate?name=aws-iot`, {
            headers: { accept: 'application/json' },
        }),
    ])

    const mqttUrl = route.mqttServer.replace(/^ssl:\/\//, 'mqtts://')

    // IoT policy allows iot:Connect only for clientId = x-client-id (the app identifier).
    // userNo is wrong — AWS IoT closes without CONNACK when clientId doesn't match the policy.
    // Confirmed by: topic path t20/op/{x-client-id}/inbox and bytesRead=0 diagnostic.
    const clientId = (client as any).headers['x-client-id'] as string
    const userNo = client.clientId

    log(`dbg: clientId(x-client-id)=${clientId}`)
    log(`dbg: userNo=${userNo}`)
    log(`dbg: broker=${mqttUrl}`)
    log(`dbg: CA cert ${caCert.split('\n').length} lines | client cert ${subscription.cert.split('\n').length} lines`)
    log(`connecting to ${mqttUrl}`)

    // CONNACK return code → human label
    const CONNACK: Record<number, string> = {
        0: 'accepted',
        1: 'bad protocol version',
        2: 'clientId rejected',
        3: 'server unavailable',
        4: 'bad credentials',
        5: 'not authorized',
    }

    // manualConnect: true prevents mqtt.js calling connect() in its constructor.
    // mqtt.js runs connect() synchronously — packetsend:connect fires before any
    // on('packetsend') we register afterwards. manualConnect lets us register first.
    const mqttClient = mqtt.connect(mqttUrl, {
        clientId,
        protocolVersion: 4,
        key: subscription.key,
        cert: subscription.cert,
        ca: caCert,
        rejectUnauthorized: false,
        reconnectPeriod: 0,
        connectTimeout: 15_000, // surface stalls faster than the 30s default
        manualConnect: true,
    })

    // ── Register ALL listeners before triggering connection ──────────────────
    mqttClient.on('packetsend', (p: any) => log(`pkt-send: ${p.cmd}`))
    mqttClient.on('packetreceive', (p: any) => {
        if (p.cmd === 'connack') {
            const label = CONNACK[p.returnCode] ?? `unknown(${p.returnCode})`
            log(`pkt-recv: connack rc=${p.returnCode} (${label})`)
        } else {
            log(`pkt-recv: ${p.cmd}`)
        }
    })
    mqttClient.on('connect', () => {
        log('connected')
        for (const topic of subscription.subscriptions) {
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
                if (err) log(`subscribe error on ${topic}: ${err.message}`)
                else log(`dbg: subscribed to ${topic}`)
            })
        }
    })
    mqttClient.on('error', (err) => log(`error: ${(err as any).code ?? ''} ${err.message}`))
    mqttClient.on('close', () => {
        const s = (mqttClient as any).stream as any
        const bw = s?.bytesWritten ?? '?'
        const br = s?.bytesRead ?? '?'
        log(`_close | bytesWritten=${bw} bytesRead=${br}`)
    })
    mqttClient.on('reconnect', () => log('_reconnect'))
    mqttClient.on('offline', () => log('_offline'))

    // ── Trigger connection (synchronous — stream is set after this returns) ──
    ;(mqttClient as any).connect()

    // ── Tap TLS/TCP socket events ─────────────────────────────────────────────
    const stream = (mqttClient as any).stream as any
    if (stream) {
        stream.on('error', (err: Error) => log(`tls-err: ${(err as any).code ?? ''} ${err.message}`))

        stream.on('secureConnect', () => {
            const cipher = stream.getCipher?.()
            const proto = stream.getProtocol?.()
            const peerCert = stream.getPeerCertificate?.()
            log(`dbg: TLS OK | proto=${proto ?? '?'} | cipher=${cipher?.name ?? '?'}`)
            log(`dbg: TLS authorized=${stream.authorized} | authErr=${stream.authorizationError ?? 'none'}`)
            if (peerCert?.subject?.CN) {
                log(
                    `dbg: server cert CN=${peerCert.subject.CN} | issuer=${peerCert.issuer?.O ?? '?'} | expires=${peerCert.valid_to ?? '?'}`,
                )
            }
        })

        stream.on('end', () => log(`dbg: stream end (peer sent close_notify) | bytesRead=${stream.bytesRead}`))

        stream.socket?.on('connect', () => log('dbg: TCP connected'))
        stream.socket?.on('close', (hadError: boolean) => log(`dbg: TCP socket closed hadError=${hadError}`))
    } else {
        log('dbg: stream not set after connect() — unexpected')
    }

    mqttClient.on('message', (topic, payload) => {
        const raw = payload.toString('utf-8')
        let parsed: unknown | null = null
        try {
            parsed = JSON.parse(raw)
        } catch {}
        opts.onMessage({ topic, payload: parsed, raw })
    })

    return mqttClient
}

async function promptCountryCode(): Promise<string> {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
        let cc = ''
        while (!/^[A-Z]{2}$/.test(cc)) {
            cc = (
                await new Promise<string>((resolve) =>
                    terminal.question('Enter the 2-letter country code (e.g. US) matching your LG account: ', resolve),
                )
            )
                .trim()
                .toUpperCase()
        }
        return cc
    } finally {
        terminal.close()
    }
}

// Interactive, run ONCE: prompt for the country code, sign in, and return the State
// (country code + refresh token) for the caller to persist. The subscription is generated
// later, by connect().
export async function login(): Promise<State> {
    const countryCode = await promptCountryCode()
    const client = new Client({ countryCode })
    const refreshToken = await oauth2Login(client)
    return { countryCode, refreshToken }
}

// Generate a fresh AWS IoT subscription (RSA key + LG-signed cert + topic list).
// Separated from connect() so callers can cache and reuse the subscription across
// reconnects — LG rate-limits certificate generation (error 9006).
export async function createSubscription(state: State, log?: (m: string) => void): Promise<Subscription> {
    const noop = log ?? (() => {})
    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    return generateSubscription(client, noop)
}

// Open an MQTT connection using a pre-existing subscription. Re-auths to get a
// fresh access token (needed for the MQTT route API call) but does NOT regenerate
// the certificate.
export async function connectWithSubscription(
    state: State,
    subscription: Subscription,
    opts: ConnectOptions,
): Promise<mqtt.MqttClient> {
    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    return openMQTT(client, subscription, opts)
}

// Non-interactive: connect to the cloud MQTT feed using a State, deliver each message to
// opts.onMessage. Generates a new subscription on every call — use createSubscription +
// connectWithSubscription directly when you need to reuse a cached cert.
export async function connect(state: State, opts: ConnectOptions): Promise<mqtt.MqttClient> {
    const log = opts.log ?? (() => {})
    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    const subscription = await generateSubscription(client, log)
    return openMQTT(client, subscription, opts)
}
