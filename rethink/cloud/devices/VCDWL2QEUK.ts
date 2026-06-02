import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'

// inner[10] — machine state.
const STATES_VCDWL: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Selected',
    0x04: 'Weighing',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, _meta: Metadata) {
        super(HA, thinq)
    }

    processAABB(inner: Buffer) {
        if (inner.length < 11 || inner[0] !== 0x20) return
        const st = inner[10]
        this.publishProperty('machine_state', STATES_VCDWL[st] ?? 'unknown')
    }
}
