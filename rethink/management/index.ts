import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express'

import path from 'path'
import { fileURLToPath } from 'url'
import log from '@/util/logging'

import HA_bridge from '@/cloud/ha_bridge'
import { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import { Bridge } from '@/bridge'
import { Request, Response } from 'express'
import { Device as T1Device } from '@/cloud/thinq1/device'
import { Device as T2Device } from '@/cloud/thinq2/device'
import { connect } from '@/util/lgcloud/monitor'
import { loadState, saveState } from '@/util/lgcloud/state'
import { Client, signInUrl } from '@/bridge/thinqApi'
import * as OAuth2 from '@/bridge/oauth2'
import type { MqttClient } from 'mqtt'

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    let subscribers: ExtendedWebSocket[] = []

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => {
            sub.send(str)
        })
    }

    function statusReport(message: string) {
        broadcast({ status: message })
    }

    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            subscribers.push(ws)

            ws.send(
                JSON.stringify({
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers = subscribers.filter((el) => el !== ws)
            })
        }, next)
    })

    ha.HA.on('statusChanged', (ha) => {
        broadcast({ ha })
    })

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false,
            }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        refreshDevices()
    }

    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', refreshDevices)

    if (bridge) {
        app.get(
            '/thinq_login',
            asyncHandler(async (req, res) => {
                res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode as string })).toString())
            }),
        )

        app.post(
            '/thinq_login_accept',
            asyncHandler(async (req, res) => {
                const url = `${req.body.url}`
                const countryCode = `${req.body.countryCode}`
                if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                    res.statusCode = 200
                    res.end()
                } else {
                    res.statusCode = 400
                    res.end()
                }
            }),
        )

        app.post(
            '/thinq_logout',
            asyncHandler(async (req, res) => {
                await bridge.logout()
                res.end()
            }),
        )

        app.post(
            '/bridge/:deviceId/enable',
            asyncHandler(async (req, res) => {
                const deviceType = typeof req.body.deviceType === 'string' ? (req.body.deviceType as string) : undefined
                try {
                    if (await bridge.enable(req.params.deviceId, deviceType, statusReport)) res.status(204).end()
                    else res.status(400).end()
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/disable',
            asyncHandler(async (req, res) => {
                await bridge.disable(req.params.deviceId)
                res.status(204).end()
            }),
        )

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
    }

    function bridgeStatus() {
        if (bridge) return { loggedIn: bridge.isLoggedIn() }
    }

    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id
        if (typeof id !== 'string') {
            res.status(400).end()
            return
        }

        res.accept().then((ws) => {
            let injectFlag = false
            let device: AnyDevice | undefined
            const onDeviceRx = (arg: Buffer) => {
                ws.send(JSON.stringify({ rx: arg.toString('hex'), injected: injectFlag }))
            }

            const onDeviceTx = (arg: Buffer | object) => {
                if (Buffer.isBuffer(arg)) ws.send(JSON.stringify({ tx: arg.toString('hex'), injected: injectFlag }))
                else ws.send(JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }))
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        ws.send(JSON.stringify({ status: 'online', meta: device.meta }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        ws.send(JSON.stringify({ status: 'offline' }))
                    }
                }
            }

            manager.on('newDevice', checkDevicePresence)
            manager.on('dropDevice', checkDevicePresence)

            checkDevicePresence()

            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg)) return

                let json: any
                try {
                    json = JSON.parse(msg.toString('utf-8'))
                } catch {
                    return
                }
                const dev = manager.allDevices[id]

                try {
                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        try {
                            injectFlag = true
                            dev.send(json.sendToDevice)
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        try {
                            injectFlag = true
                            dev.send_packet(Buffer.from(json.sendToDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (json.sendFromDevice && dev) {
                        try {
                            injectFlag = true
                            dev.emit('data', Buffer.from(json.sendFromDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }
                } catch (err) {
                    log('MGMT', id, `inject error: ${err}`)
                }
            })

            ws.on('close', () => {
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            })
        }, next)
    })

    // ── LG cloud notification monitor ────────────────────────────────────────
    // Singleton MQTT connection to LG's cloud notification feed. Started lazily
    // on the first browser connection; kept alive for the process lifetime once
    // started so subsequent connections don't need to re-run the slow openssl /
    // certificate API round-trip. All browser subscribers share one feed.
    let cloudMqtt: MqttClient | undefined
    let cloudConnecting = false
    let cloudSubscribers: ExtendedWebSocket[] = []

    function broadcastCloud(message: object) {
        const str = JSON.stringify(message)
        cloudSubscribers.forEach((sub) => {
            try {
                sub.send(str)
            } catch {}
        })
    }

    async function ensureCloudConnected() {
        if (cloudMqtt || cloudConnecting) return
        cloudConnecting = true
        broadcastCloud({ cloudStatus: 'connecting' })
        try {
            const state = loadState()
            if (!state) {
                broadcastCloud({ cloudStatus: 'not-logged-in' })
                return
            }
            cloudMqtt = await connect(state, {
                onMessage: (msg) => broadcastCloud({ cloud: msg }),
                log: (m) => {
                    log('CLOUD', m)
                    broadcastCloud({ cloudStatus: m })
                },
            })
            broadcastCloud({ cloudStatus: 'connected' })
        } catch (err) {
            log('CLOUD', `connection failed: ${err}`)
            broadcastCloud({ cloudStatus: `error: ${err}` })
        } finally {
            cloudConnecting = false
        }
    }

    app.ws('/lgcloud', (req, res, next) => {
        res.accept().then((ws) => {
            cloudSubscribers.push(ws)

            // Tell this browser the current state immediately
            if (cloudMqtt) {
                ws.send(JSON.stringify({ cloudStatus: 'connected' }))
            } else if (cloudConnecting) {
                ws.send(JSON.stringify({ cloudStatus: 'connecting' }))
            } else {
                ws.send(JSON.stringify({ cloudStatus: 'idle' }))
                ensureCloudConnected()
            }

            ws.on('close', () => {
                cloudSubscribers = cloudSubscribers.filter((s) => s !== ws)
            })
        }, next)
    })

    // ── LG cloud monitor login ────────────────────────────────────────────────
    // Step 1: redirect the browser to LG's OAuth sign-in page.
    app.get(
        '/lgcloud_login',
        asyncHandler(async (req, res) => {
            const countryCode = `${req.query.countryCode ?? ''}`.toUpperCase()
            if (!/^[A-Z]{2}$/.test(countryCode)) {
                res.status(400).end('Invalid country code')
                return
            }
            const client = new Client({ countryCode })
            const base = await client.getUrls()
            res.redirect(signInUrl(base.webUrl, countryCode).toString())
        }),
    )

    // Step 2: exchange the OAuth code, persist oauth.json, trigger cloud connection.
    app.post(
        '/lgcloud_login_accept',
        asyncHandler(async (req, res) => {
            const countryCode = `${req.body.countryCode ?? ''}`.toUpperCase()
            if (!/^[A-Z]{2}$/.test(countryCode)) {
                res.status(400).end('Invalid country code')
                return
            }
            let code: string | null = null
            try {
                code = new URL(`${req.body.url}`).searchParams.get('code')
            } catch {
                res.status(400).end('Invalid URL')
                return
            }
            if (!code) {
                res.status(400).end('No code parameter in URL')
                return
            }
            const client = new Client({ countryCode })
            const base = await client.getUrls()
            const { refreshToken } = await OAuth2.fromCode(base.authUrl, code)
            saveState({ countryCode, refreshToken })
            res.status(200).end()
            // Start the cloud MQTT connection now that credentials exist.
            ensureCloudConnected()
        }),
    )

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    return app.createServer()
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
