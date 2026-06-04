// base implementation for devices with a AA...BB payload format
import HADevice from './base.js';
export default class AABBDevice extends HADevice {
    constructor(HA, thinq) {
        super(HA, thinq.id);
        this.thinq = thinq;
        this.publishCache = {};
        thinq.on('data', (data) => this.processData(data));
    }
    // sends a packet of the format:
    // AA [length] ...inner [checksum] BB
    send(inner) {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])]);
        const sum = packet.reduce((pv, cv) => pv + cv, 0);
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55;
        packet[packet.length - 1] = 0xbb;
        this.thinq.send_packet(packet);
    }
    processData(buf) {
        if (buf.length >= 4 && buf[0] == 0xaa && buf[buf.length - 1] == 0xbb) {
            this.processAABB(buf.subarray(2, buf.length - 2));
        }
    }
    processAABB(buf) {
        throw new Error('To be overriden');
    }
    // to be called by processAABB
    publishProperty(prop, value) {
        if (this.publishCache[prop] === value)
            return;
        this.publishCache[prop] = value;
        this.HA.publishProperty(this.id, prop, value);
    }
    getProperty(prop) {
        return this.publishCache[prop];
    }
}
