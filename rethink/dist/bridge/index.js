var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Bridge_instances, _Bridge_start, _Bridge_stop;
import { Client as ThinqClient, signInUrl, Thinq1Device, Thinq2Device, } from './thinqApi.js';
import * as OAuth2 from './oauth2.js';
import { Connection as Thinq1Connection } from './thinq1connection.js';
import { Connection as Thinq2Connection } from './thinq2connection.js';
import { Device as T1Downstream } from '../cloud/thinq1/device.js';
import { Device as T2Downstream } from '../cloud/thinq2/device.js';
import { TypedEmitter } from 'tiny-typed-emitter';
import log from '../util/logging.js';
function isThinq1State(state) {
    return 'rtiServer' in state;
}
const RECONNECT_PERIOD = 5000;
class BridgedDevice {
    // upstream - our connection to the ThinQ cloud
    // downstream - the physical device
    constructor(upstream, downstream) {
        this.upstream = upstream;
        this.downstream = downstream;
        // we create the functions at runtime so that they have unique identities that can be removed with removeListener
        this.onDownstreamData = (packet) => this.connection?.send(packet);
        this.onDownstreamClose = () => this.destroy();
        if (this.upstream.platformType !== this.downstream.platform) {
            console.warn("Bridge device types don't match");
            return;
        }
        downstream.on('data', this.onDownstreamData);
        downstream.on('close', this.onDownstreamClose);
        this.reconnectNow();
    }
    reconnectNow() {
        const U = this.upstream;
        const D = this.downstream;
        if (U instanceof Thinq1Device && D instanceof T1Downstream) {
            this.connection = new Thinq1Connection(U);
            // feed the initial state to the connection
            if (D.lastReport)
                this.connection.send(D.lastReport);
            this.connection.on('data', (payload) => D.send(payload));
        }
        else if (U instanceof Thinq2Device && D instanceof T2Downstream) {
            this.connection = new Thinq2Connection(U);
            this.connection.on('data', (payload) => D.send_packet(payload));
        }
        else {
            console.warn("Can't connect bridge");
            return;
        }
        this.connection.on('close', () => this.disconnect());
        this.connection.on('error', (err) => log('bridge', `connection error: ${err}`));
    }
    disconnect() {
        if (this.connection) {
            this.connection.destroy();
            this.connection = undefined;
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => this.reconnectNow(), RECONNECT_PERIOD);
        }
    }
    destroy() {
        if (this.connection) {
            this.connection.destroy();
            this.connection = undefined;
        }
        this.downstream.removeListener('data', this.onDownstreamData);
        this.downstream.removeListener('close', this.onDownstreamClose);
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
    }
}
export class Bridge extends TypedEmitter {
    constructor(state, manager) {
        super();
        _Bridge_instances.add(this);
        this.state = state;
        this.manager = manager;
        this.bridgedDevices = new Map();
        this.manager.on('newDevice', __classPrivateFieldGet(this, _Bridge_instances, "m", _Bridge_start).bind(this));
        this.manager.on('dropDevice', __classPrivateFieldGet(this, _Bridge_instances, "m", _Bridge_stop).bind(this));
        Object.values(this.manager.allDevices).forEach(__classPrivateFieldGet(this, _Bridge_instances, "m", _Bridge_start).bind(this));
    }
    status(id) {
        const dev = this.manager.allDevices[id];
        if (!dev)
            return undefined;
        if (this.bridgedDevices.has(id))
            return true;
        return false;
    }
    async enable(id, devType, statusCallback) {
        if (!this.isLoggedIn())
            return false;
        if (this.bridgedDevices.has(id))
            return true;
        const dev = this.manager.allDevices[id];
        if (!dev)
            return false;
        const clientDevice = await this.register(dev, devType, statusCallback);
        if (!clientDevice)
            return false;
        const bridged = new BridgedDevice(clientDevice, dev);
        this.bridgedDevices.set(dev.id, bridged);
        this.emit('started', dev.id);
        return true;
    }
    disable(id) {
        this.state.setDeviceState(id, undefined);
        __classPrivateFieldGet(this, _Bridge_instances, "m", _Bridge_stop).call(this, id);
    }
    isLoggedIn() {
        return !!this.state.getCredentials();
    }
    async beginLogin(env) {
        const client = new ThinqClient(env);
        const base = await client.getUrls();
        return signInUrl(base.webUrl, env.countryCode);
    }
    async completeLogin(env, url) {
        const client = new ThinqClient(env);
        const base = await client.getUrls();
        const code = url.searchParams.get('code');
        if (!code)
            return false;
        const token = await OAuth2.fromCode(base.authUrl, code);
        this.state.setCredentials({
            env,
            refreshToken: token.refreshToken,
        });
        this.emit('loggedIn');
        return true;
    }
    logout() {
        this.state.setCredentials(undefined);
        for (const id of Array.from(this.bridgedDevices.keys()))
            __classPrivateFieldGet(this, _Bridge_instances, "m", _Bridge_stop).call(this, id);
        this.emit('loggedOut');
    }
    async register(device, deviceType, statusCallback) {
        if (!statusCallback)
            statusCallback = () => { };
        const creds = this.state.getCredentials();
        if (!creds)
            throw new Error('Not logged in');
        if (!deviceType)
            deviceType = device.meta.deviceType;
        if (!deviceType)
            throw new Error('Device type must be specified');
        const client = new ThinqClient(creds.env);
        await client.auth(creds.refreshToken);
        statusCallback('Removing device from home');
        await client.removeDevice(device.id);
        let clientDevice;
        if (device.platform === 'thinq1') {
            const gateway = await client.gateway;
            const state = {
                httpServer: gateway.thinq1Uri.replace(/\/api$/, ''),
                rtiServer: gateway.rtiUri,
            };
            clientDevice = new Thinq1Device(device.id, device.meta, state);
            statusCallback('Adding device to home');
            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType);
        }
        else if (device.platform === 'thinq2') {
            statusCallback('Fetching otp key');
            const otp = await client.prepareNewT2Device();
            const t2 = new Thinq2Device(device.id, device.meta);
            clientDevice = t2;
            statusCallback('Registering new device');
            const ciphertext = await t2.pair(client.env, otp);
            statusCallback('Adding device to home');
            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType, ciphertext);
        }
        else {
            throw new Error('Unknown device platform');
        }
        statusCallback('Device registered successfully');
        this.state.setDeviceState(device.id, clientDevice.state);
        return clientDevice;
    }
    loadSavedDevice(device) {
        const state = this.state.getDeviceState(device.id);
        if (state) {
            if (isThinq1State(state))
                return new Thinq1Device(device.id, device.meta, state);
            return new Thinq2Device(device.id, device.meta, state);
        }
        return undefined;
    }
}
_Bridge_instances = new WeakSet(), _Bridge_start = function _Bridge_start(dev) {
    const clientDevice = this.loadSavedDevice(dev);
    if (!clientDevice)
        return;
    const bridged = new BridgedDevice(clientDevice, dev);
    this.bridgedDevices.set(dev.id, bridged);
    this.emit('started', dev.id);
}, _Bridge_stop = function _Bridge_stop(id) {
    const bridged = this.bridgedDevices.get(id);
    if (bridged) {
        this.bridgedDevices.delete(id);
        this.emit('stopped', id);
        bridged.destroy();
    }
};
