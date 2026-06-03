import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { allowExtendedType } from '@/util/casting'

// inner[10] — run state.
const STATES_VCDWL: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Running',
    0x04: 'End',
    0xe2: 'AntiCrease',
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
    0x27: 0, // seen in Blandmaterial final spin; actual RPM unconfirmed
}

// (sub[1] << 8) | sub[2] — cycle phase. Multiple equivalent encodings
// per phase per the wiki notes.
const PHASES_VCDWL: Record<number, string> = {
    0x0000: 'Finished', // post-cycle Running packets: phA=0x00, phB=0x00
    0x0310: 'Idle',
    0x0510: 'Idle',
    0x0810: 'Idle',
    0x0110: 'WashFill',
    0x0b10: 'WashTumble',
    0x260b: 'WashDrain',
    0x0b26: 'WashDrain',
    0x0010: 'Tumble', // active tumbling — appears in both wash and rinse phases
    0x0006: 'Drain', // end-of-cycle drain observed in Blandmaterial captures
    0x040e: 'RinseFill',
    0x060e: 'RinseTumble',
    0x0e0c: 'RinseDrain',
    0x0c0e: 'RinseDrain',
    0x080e: 'SpinActive',
    0x0a0e: 'SpinActive',
    0x100e: 'Finished',
}

function decodePhase(phA: number, phB: number): string {
    if (phA === 0x18 && phB >= 0x12 && phB <= 0x1f) return 'SpinRamp'
    return PHASES_VCDWL[(phA << 8) | phB] ?? 'unknown'
}

/**
 * Find the status sub-block in a long status packet.
 *
 * Two sub-block variants exist:
 *   0x05-variant (DisplayOn / spin phases):
 *     05 PH_A PH_B SP CS 00 ... CS 01
 *   0x03-variant (Running — weight-detect, wash, rinse, spin):
 *     03 PH_A PH_B SP CS 00 ... CS 0b
 *
 * Common layout (positions relative to sub-block start):
 *   [1]  PH_A   [2]  PH_B   [3] spin   [4] course
 *   [5]  0x00 (anchor)      [13] remaining_time_lo  [14] remaining_time_hi
 *   [15] initial_time_lo    [19] course (repeated — anchor)
 *
 * Long packets contain either two sub-blocks (steady-state) or one
 * device-info block followed by one status sub-block (boot-up). The STATUS
 * sub-block is always last; we scan backwards.
 */
function findStatusSubBlock(inner: Buffer): number {
    for (let i = inner.length - 21; i >= 14; i--) {
        const marker = inner[i]
        if (marker !== 0x05 && marker !== 0x03 && marker !== 0x00) continue
        const cs = inner[i + 4]
        if (cs === 0x00) continue
        if (inner[i + 5] !== 0x00) continue

        if (inner[i + 19] === cs) return i
    }
    return -1
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const courseOptions = [...Object.values(COURSES_VCDWL), 'unknown']
        const phaseOptions = [
            'Idle',
            'WashFill',
            'WashTumble',
            'WashDrain',
            'Tumble',
            'Drain',
            'RinseFill',
            'RinseTumble',
            'RinseDrain',
            'SpinRamp',
            'SpinActive',
            'Finished',
            'unknown',
        ]
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG F4X7511TWS' }),
                components: {
                    run_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-run_state',
                        state_topic: '$this/run_state',
                        name: 'Run state',
                        icon: 'mdi:power',
                        device_class: 'enum',
                        options: ['Standby', 'Running', 'End', 'AntiCrease'],
                    },
                    cycle_phase: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle_phase',
                        state_topic: '$this/cycle_phase',
                        name: 'Cycle phase',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: phaseOptions,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Program',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: courseOptions,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: ['Cold', '20-30', '40', '60', 'unknown'],
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin speed',
                        icon: 'mdi:fan',
                        unit_of_measurement: 'rpm',
                        state_class: 'measurement',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Time remaining',
                        icon: 'mdi:timer-outline',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                    },
                },
            }),
        )
    }

    processAABB(inner: Buffer) {
        if (inner.length < 11 || inner[0] !== 0x20) return

        const st = inner[10]
        const stateLabel = STATES_VCDWL[st]

        // Unknown ST bytes (e.g. 0x4d telemetry bursts) — suppress rather than
        // publishing a garbage label and disrupting the HA sensor.
        if (stateLabel === undefined) return

        // DisplayOn is transient user-browsing; keep the last meaningful state visible.
        // Sub-block processing continues so course/spin/temp stay current.
        if (st !== 0xeb) this.publishProperty('run_state', stateLabel)

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

        // sub[20] is the terminator byte: 0x01 for temp-scroll sub-blocks (21 bytes),
        // 0x0b for active-running sub-blocks (50 bytes). Both have cs-repeat at sub[19].
        // Only publish temp when it's a temp-scroll sub-block in Idle phase.
        const subMarker = inner[subStart]
        if (subMarker === 0x05 && sub[20] === 0x01 && phase === 'Idle') {
            this.publishProperty('temp', TEMPERATURES_VCDWL[sub[13]] ?? 'unknown')
        } else {
            const remaining = sub[13] | (sub[14] << 8)
            this.publishProperty('remaining_time', remaining)
        }
    }

    setProperty(_prop: string, _mqttValue: string) {
        // sensors-only v1; ignore HA writes silently.
    }
}
