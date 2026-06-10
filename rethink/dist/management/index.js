import { WebSocketExpress } from 'websocket-express';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../util/logging.js';
import { Device as T1Device } from '../cloud/thinq1/device.js';
import { Device as T2Device } from '../cloud/thinq2/device.js';
import { connect } from '../util/lgcloud/monitor.js';
import { loadState, saveState } from '../util/lgcloud/state.js';
import { Client, signInUrl } from '../bridge/thinqApi.js';
import * as OAuth2 from '../bridge/oauth2.js';
export function app(ha, manager, bridge) {
    const app = new WebSocketExpress();
    let subscribers = [];
    // device management
    function broadcast(message) {
        const str = JSON.stringify(message);
        subscribers.forEach((sub) => {
            try {
                sub.send(str);
            }
            catch { }
        });
    }
    function statusReport(message) {
        broadcast({ status: message });
    }
    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url);
        next();
    });
    app.use(WebSocketExpress.json());
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            subscribers.push(ws);
            ws.send(JSON.stringify({
                ha: ha.HA.isConnected,
                bridge: bridgeStatus(),
                devices: enumDevices(),
            }));
            ws.on('close', () => {
                subscribers = subscribers.filter((el) => el !== ws);
            });
        }, next);
    });
    ha.HA.on('statusChanged', (ha) => {
        broadcast({ ha });
    });
    function enumDevices() {
        const allDevices = {};
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id];
            const meta = dev.meta;
            allDevices[id] = {
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false,
            };
        }
        return allDevices;
    }
    function refreshDevices() {
        broadcast({ devices: enumDevices() });
    }
    function onNewDevice(dev) {
        refreshDevices();
    }
    manager.on('newDevice', onNewDevice);
    manager.on('dropDevice', refreshDevices);
    if (bridge) {
        app.get('/thinq_login', asyncHandler(async (req, res) => {
            res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode })).toString());
        }));
        app.post('/thinq_login_accept', asyncHandler(async (req, res) => {
            const url = `${req.body.url}`;
            const countryCode = `${req.body.countryCode}`;
            if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                res.statusCode = 200;
                res.end();
            }
            else {
                res.statusCode = 400;
                res.end();
            }
        }));
        app.post('/thinq_logout', asyncHandler(async (req, res) => {
            await bridge.logout();
            res.end();
        }));
        app.post('/bridge/:deviceId/enable', asyncHandler(async (req, res) => {
            const deviceType = typeof req.body.deviceType === 'string' ? req.body.deviceType : undefined;
            try {
                if (await bridge.enable(req.params.deviceId, deviceType, statusReport))
                    res.status(204).end();
                else
                    res.status(400).end();
            }
            catch (err) {
                res.status(500).end(`${err}`);
            }
        }));
        app.post('/bridge/:deviceId/disable', asyncHandler(async (req, res) => {
            await bridge.disable(req.params.deviceId);
            res.status(204).end();
        }));
        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() });
        }
        bridge.on('loggedIn', refreshBridgeStatus);
        bridge.on('loggedOut', refreshBridgeStatus);
        bridge.on('started', refreshDevices);
        bridge.on('stopped', refreshDevices);
    }
    function bridgeStatus() {
        if (bridge)
            return { loggedIn: bridge.isLoggedIn() };
    }
    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id;
        if (typeof id !== 'string') {
            res.status(400).end();
            return;
        }
        res.accept().then((ws) => {
            let injectFlag = false;
            let device;
            const onDeviceRx = (arg) => {
                ws.send(JSON.stringify({ rx: arg.toString('hex'), injected: injectFlag }));
            };
            const onDeviceTx = (arg) => {
                if (Buffer.isBuffer(arg))
                    ws.send(JSON.stringify({ tx: arg.toString('hex'), injected: injectFlag }));
                else
                    ws.send(JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }));
            };
            const checkDevicePresence = () => {
                const dev = manager.allDevices[id];
                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx);
                    device?.removeListener('sendData', onDeviceTx);
                    device = dev;
                    if (device) {
                        ws.send(JSON.stringify({ status: 'online', meta: device.meta }));
                        device.on('data', onDeviceRx);
                        device.on('sendData', onDeviceTx);
                    }
                    else {
                        ws.send(JSON.stringify({ status: 'offline' }));
                    }
                }
            };
            manager.on('newDevice', checkDevicePresence);
            manager.on('dropDevice', checkDevicePresence);
            checkDevicePresence();
            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg))
                    return;
                let json;
                try {
                    json = JSON.parse(msg.toString('utf-8'));
                }
                catch {
                    return;
                }
                const dev = manager.allDevices[id];
                try {
                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        try {
                            injectFlag = true;
                            dev.send(json.sendToDevice);
                        }
                        finally {
                            injectFlag = false;
                        }
                    }
                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        try {
                            injectFlag = true;
                            dev.send_packet(Buffer.from(json.sendToDevice, 'hex'));
                        }
                        finally {
                            injectFlag = false;
                        }
                    }
                    if (json.sendFromDevice && dev) {
                        try {
                            injectFlag = true;
                            dev.emit('data', Buffer.from(json.sendFromDevice, 'hex'));
                        }
                        finally {
                            injectFlag = false;
                        }
                    }
                }
                catch (err) {
                    log('MGMT', id, `inject error: ${err}`);
                }
            });
            ws.on('close', () => {
                manager.removeListener('newDevice', checkDevicePresence);
                manager.removeListener('dropDevice', checkDevicePresence);
            });
        }, next);
    });
    let cloud = { status: 'idle' };
    let cloudSubscribers = [];
    let lastCertGeneratedAt = 0;
    const CERT_MIN_INTERVAL = 65_000; // LG rate-limits cert generation; ~60 s observed
    function broadcastCloud(message) {
        const str = JSON.stringify(message);
        cloudSubscribers.forEach((sub) => {
            try {
                sub.send(str);
            }
            catch { }
        });
    }
    async function ensureCloudConnected() {
        if (cloud.status === 'connecting' || cloud.status === 'connected')
            return;
        if (cloud.status === 'rate-limited') {
            const wait = cloud.retryAt - Date.now();
            if (wait > 0) {
                broadcastCloud({ cloudStatus: `reconnecting in ${Math.ceil(wait / 1000)}s…` });
                setTimeout(ensureCloudConnected, wait);
                return;
            }
        }
        // Respect LG's cert-generation rate limit.
        const sinceLastCert = Date.now() - lastCertGeneratedAt;
        if (sinceLastCert < CERT_MIN_INTERVAL) {
            const retryAt = Date.now() + (CERT_MIN_INTERVAL - sinceLastCert);
            cloud = { status: 'rate-limited', retryAt };
            broadcastCloud({ cloudStatus: `reconnecting in ${Math.ceil((retryAt - Date.now()) / 1000)}s…` });
            setTimeout(ensureCloudConnected, retryAt - Date.now());
            return;
        }
        cloud = { status: 'connecting' };
        broadcastCloud({ cloudStatus: 'connecting' });
        try {
            const state = loadState();
            if (!state) {
                cloud = { status: 'idle' };
                broadcastCloud({ cloudStatus: 'not-logged-in' });
                return;
            }
            broadcastCloud({ cloudStatus: 'generating certificate…' });
            lastCertGeneratedAt = Date.now();
            const client = await connect(state, {
                onMessage: (msg) => broadcastCloud({ cloud: msg }),
                log: (m) => {
                    log('CLOUD', m);
                    if (m === 'connected') {
                        // connect() has already resolved so `client` is assigned.
                        cloud = { status: 'connected', client };
                        broadcastCloud({ cloudStatus: 'connected' });
                        return;
                    }
                    if (m === '_close') {
                        broadcastCloud({ cloudStatus: 'disconnected' });
                        cloud = { status: 'idle' };
                        return;
                    }
                    if (m === '_offline')
                        return;
                    broadcastCloud({ cloudStatus: m });
                },
            });
            if (cloud.status === 'connecting')
                cloud = { status: 'connected', client };
        }
        catch (err) {
            log('CLOUD', `connection failed: ${err}`);
            broadcastCloud({ cloudStatus: `error: ${err}` });
            cloud = { status: 'idle' };
        }
    }
    app.ws('/lgcloud', (req, res, next) => {
        res.accept().then((ws) => {
            cloudSubscribers.push(ws);
            // Tell this browser the current state immediately
            if (cloud.status === 'connected') {
                ws.send(JSON.stringify({ cloudStatus: 'connected' }));
            }
            else if (cloud.status === 'connecting') {
                ws.send(JSON.stringify({ cloudStatus: 'connecting' }));
            }
            else {
                ws.send(JSON.stringify({ cloudStatus: 'idle' }));
                ensureCloudConnected();
            }
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(String(data));
                    if (msg.reconnect) {
                        broadcastCloud({ cloudStatus: 'reconnecting' });
                        if (cloud.status === 'connected') {
                            try {
                                cloud.client.end(true);
                            }
                            catch { }
                        }
                        cloud = { status: 'idle' };
                        ensureCloudConnected();
                    }
                }
                catch { }
            });
            ws.on('close', () => {
                cloudSubscribers = cloudSubscribers.filter((s) => s !== ws);
            });
        }, next);
    });
    // ── LG cloud monitor login ────────────────────────────────────────────────
    // Step 1: redirect the browser to LG's OAuth sign-in page.
    app.get('/lgcloud_login', asyncHandler(async (req, res) => {
        const countryCode = `${req.query.countryCode ?? ''}`.toUpperCase();
        if (!/^[A-Z]{2}$/.test(countryCode)) {
            res.status(400).end('Invalid country code');
            return;
        }
        const client = new Client({ countryCode });
        const base = await client.getUrls();
        res.redirect(signInUrl(base.webUrl, countryCode).toString());
    }));
    // Step 2: exchange the OAuth code, persist oauth.json, trigger cloud connection.
    app.post('/lgcloud_login_accept', asyncHandler(async (req, res) => {
        const countryCode = `${req.body.countryCode ?? ''}`.toUpperCase();
        if (!/^[A-Z]{2}$/.test(countryCode)) {
            res.status(400).end('Invalid country code');
            return;
        }
        let code = null;
        try {
            code = new URL(`${req.body.url}`).searchParams.get('code');
        }
        catch {
            res.status(400).end('Invalid URL');
            return;
        }
        if (!code) {
            res.status(400).end('No code parameter in URL');
            return;
        }
        const client = new Client({ countryCode });
        const base = await client.getUrls();
        const { refreshToken } = await OAuth2.fromCode(base.authUrl, code);
        saveState({ countryCode, refreshToken });
        res.status(200).end();
        // Start the cloud MQTT connection now that credentials exist.
        ensureCloudConnected();
    }));
    // Trigger HA Supervisor addon store reload so the latest version is visible
    // without requiring an HA restart. Call this once after a new release.
    app.post('/supervisor/store-reload', asyncHandler(async (req, res) => {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) {
            res.status(503).end('Not running inside HA Supervisor');
            return;
        }
        const r = await fetch('http://supervisor/store/reload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        res.status(r.ok ? 200 : 502).end();
    }));
    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }));
    return app.createServer();
}
function asyncHandler(handler) {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}
