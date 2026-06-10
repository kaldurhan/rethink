// base implementation for devices with a AA...BB payload format
import HADevice from './base.js';
export default class AABBDevice extends HADevice {
    constructor(HA, thinq) {
        super(HA, thinq.id);
        this.thinq = thinq;
        this.publishCache = {};
        this.offTimer = null;
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
    // Publish 'Off' to the stage property after a delay. If a Standby packet or
    // a new active cycle arrives first, cancelOffTimer() prevents the publish.
    scheduleOff(delayMs = 5 * 60 * 1000) {
        if (this.offTimer !== null)
            clearTimeout(this.offTimer);
        this.offTimer = setTimeout(() => {
            this.offTimer = null;
            this.publishProperty('stage', 'Off');
        }, delayMs);
    }
    cancelOffTimer() {
        if (this.offTimer !== null) {
            clearTimeout(this.offTimer);
            this.offTimer = null;
        }
    }
}
