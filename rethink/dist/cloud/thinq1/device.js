import { TypedEmitter } from 'tiny-typed-emitter';
import { Connection } from './connection.js';
import { getDeviceMetadata } from './http.js';
import { randomUUID } from 'node:crypto';
export class Device extends TypedEmitter {
    constructor(con, id, meta) {
        super();
        this.con = con;
        this.id = id;
        this.meta = meta;
        this.platform = 'thinq1';
        con.deviceObj = this;
        con.on('status', (packet) => {
            this.lastReport = packet;
            this.emit('data', packet);
        });
        con.on('error', console.log);
        con.on('close', () => {
            if (con.deviceObj === this) {
                this.emit('close');
                con.deviceObj = undefined;
            }
        });
    }
    send(body) {
        this.emit('sendData', body);
        this.con.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`,
            },
        });
    }
}
export class DeviceAcceptor extends TypedEmitter {
    constructor() {
        super();
        this.connectionsById = {};
    }
    accept(socket) {
        const con = new Connection(socket);
        con.on('error', () => { }); // ignore errors at this stage
        con.on('init', (deviceId) => {
            console.log('here', deviceId);
            const meta = getDeviceMetadata(deviceId);
            if (!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`);
                con.destroy();
                return;
            }
            if (this.connectionsById[deviceId]) {
                console.warn(`device ${deviceId} already connected, dropping the old one`);
                this.connectionsById[deviceId].destroy();
            }
            this.connectionsById[deviceId] = con;
            con.on('close', () => {
                if (this.connectionsById[deviceId] === con) {
                    delete this.connectionsById[deviceId];
                    this.emit('dropDevice', deviceId);
                }
            });
            con.removeAllListeners('error');
            const dev = new Device(con, deviceId, meta);
            this.emit('newDevice', dev);
        });
    }
}
