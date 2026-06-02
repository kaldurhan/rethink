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

// sub[4] — course code. sub[5] is always 0x00 (the LE high byte).
const COURSES_VCDWL: Record<number, string> = {
    0x2b: 'Blandmaterial',
    0x7a: 'Turbowash 39',
    0x4f: 'Sportkläder',
    0x55: 'Rengöring av trumman',
    0x4b: 'Quick 14',
    0x5e: 'Hand / Ull',
    0x2e: 'Bomull',
    0x72: 'AI - Tvätt',
    0x13: 'Eco 40-60',
    0x16: 'Fintvätt',
    0x1d: 'Strykfritt',
    0x88: 'Skötsel av mikroplaster',
    0x04: 'Allergivård',
}

// sub[13] — temperature lookup (only when phase Idle).
const TEMPERATURES_VCDWL: Record<number, string> = {
    0x70: 'Cold',
    0x7a: '20-30',
    0x84: '40',
    0x98: '60',
}

// sub[3] — spin speed lookup.
const SPINS_VCDWL: Record<number, number> = {
    0x06: 400,
    0x08: 800,
    0x09: 1000,
    0x0c: 1200,
    0x01: 1400,
}

// (sub[1] << 8) | sub[2] — cycle phase. Multiple equivalent encodings
// per phase per the wiki notes.
const PHASES_VCDWL: Record<number, string> = {
    0x0310: 'Idle',
    0x0510: 'Idle',
    0x0810: 'Idle',
    0x0110: 'WashFill',
    0x0b10: 'WashTumble',
    0x260b: 'WashDrain',
    0x0b26: 'WashDrain',
    0x040e: 'RinseFill',
    0x060e: 'RinseTumble',
    0x0e0c: 'RinseDrain',
    0x0c0e: 'RinseDrain',
    0x080e: 'SpinActive',
    0x0a0e: 'SpinActive',
    0x100e: 'Finished',
    0x0010: 'Finished',
}

function decodePhase(phA: number, phB: number): string {
    if (phA === 0x18 && phB >= 0x12 && phB <= 0x1f) return 'SpinRamp'
    return PHASES_VCDWL[(phA << 8) | phB] ?? 'unknown'
}

/**
 * Find the status sub-block in a long status packet.
 *
 * Each sub-block has the shape:
 *   05 PH_A PH_B SP CS 00 00 00 00 00 00 00 00 00 TT_LO 00 TT_DUP 00 00 00 CS 01
 *   0  1    2   3  4  5  6  7  8  9 10 11 12 13 14    15 16     17 18 19 20
 *
 * Long packets contain either two status sub-blocks (steady-state) or one
 * device-info sub-block followed by one status sub-block (boot-up). The
 * STATUS sub-block is always the last one. We scan from the end backwards
 * for the unique signature: 0x05 at the start, repeated CS byte at +19,
 * 0x01 at +20.
 */
function findStatusSubBlock(inner: Buffer): number {
    for (let i = inner.length - 21; i >= 14; i--) {
        if (inner[i] === 0x05 && inner[i + 5] === 0x00 && inner[i + 20] === 0x01 && inner[i + 19] === inner[i + 4]) {
            return i
        }
    }
    return -1
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, _meta: Metadata) {
        super(HA, thinq)
    }

    processAABB(inner: Buffer) {
        if (inner.length < 11 || inner[0] !== 0x20) return

        const st = inner[10]
        this.publishProperty('machine_state', STATES_VCDWL[st] ?? 'unknown')

        // Short standby packet — no sub-block, leave other props untouched.
        if (inner.length < 32) return

        const subStart = findStatusSubBlock(inner)
        if (subStart < 0) return
        const sub = inner.subarray(subStart, subStart + 21)

        const phase = decodePhase(sub[1], sub[2])
        this.publishProperty('cycle_phase', phase)

        const sp = sub[3]
        this.publishProperty('spin', SPINS_VCDWL[sp] ?? 0)

        const cs = sub[4]
        this.publishProperty('course', COURSES_VCDWL[cs] ?? `unknown_0x${cs.toString(16).padStart(2, '0')}`)

        if (phase === 'Idle') {
            this.publishProperty('temp', TEMPERATURES_VCDWL[sub[13]] ?? 'unknown')
        } else {
            const remaining = sub[13] | (sub[14] << 8)
            this.publishProperty('remaining_time', remaining)
        }
    }
}
