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
    0x0210: 'Idle', // 20-30°C settled (scroll series: 0x0110→0x0210→0x0310→0x0510)
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
    // 0x_0e variants observed in programme-selection sub-blocks (machine idle, user browsing).
    // These share the low byte 0x0e with the operational rinse/spin phases above but are
    // distinct codes that only appear while the drum is not running.
    0x010e: 'Idle',
    0x020e: 'Idle',
    0x030e: 'Idle',
    0x050e: 'Idle',
}

function decodePhase(phA: number, phB: number): string {
    if (phA === 0x18 && phB >= 0x12 && phB <= 0x1f) return 'SpinRamp'
    return PHASES_VCDWL[(phA << 8) | phB] ?? 'unknown'
}

/**
 * Find the last 10 08 energy-tracking block in the inner buffer.
 * Layout from block start:
 *   [0..1]   = 10 08 (marker)
 *   [2]      = course code
 *   [11..12] = remaining time LE u16 (minutes)
 *   [14..15] = courseSpendPower BE u16 (Wh)
 */
function findPowerBlock(inner: Buffer): number {
    let found = -1
    for (let i = 0; i <= inner.length - 16; i++) {
        if (inner[i] === 0x10 && inner[i + 1] === 0x08) found = i
    }
    return found
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
    // Timestamp of the last 0x76 sub-block decode. Used to gate 0x53 SpinRamp
    // publishes: during active tumble, 0x76 fires every ~60s so this stays fresh;
    // during the final drain+spin, no 0x76 arrives for 15+ min so 0x53 is allowed
    // to update cycle_phase to SpinRamp.
    lastTumbleTime = 0
    // Count of intermediate spin-ramp events seen in the current cycle.
    // 0 = still in wash phase; ≥1 = rinse phase has begun.
    spinRampsSeen = 0

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
                    course_spend_power: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course_spend_power',
                        state_topic: '$this/course_spend_power',
                        name: 'Cycle energy',
                        icon: 'mdi:lightning-bolt',
                        unit_of_measurement: 'Wh',
                        state_class: 'measurement',
                        device_class: 'energy',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                        payload_on: 'open',
                        payload_off: 'closed',
                    },
                    water_temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-water_temp',
                        state_topic: '$this/water_temp',
                        name: 'Water temperature',
                        icon: 'mdi:thermometer-water',
                        unit_of_measurement: '°C',
                        state_class: 'measurement',
                        device_class: 'temperature',
                    },
                    elapsed_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-elapsed_time',
                        state_topic: '$this/elapsed_time',
                        name: 'Elapsed time',
                        icon: 'mdi:timer-play-outline',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                    },
                    phase_remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-phase_remaining_time',
                        state_topic: '$this/phase_remaining_time',
                        name: 'Phase time remaining',
                        icon: 'mdi:timer-outline',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                    },
                    stage: {
                        platform: 'sensor',
                        unique_id: '$deviceid-stage',
                        state_topic: '$this/stage',
                        name: 'Stage',
                        icon: 'mdi:washing-machine',
                        device_class: 'enum',
                        options: ['Off', 'Washing', 'Rinsing', 'Spinning', 'Done'],
                    },
                },
            }),
        )
    }

    processAABB(inner: Buffer) {
        if (inner.length < 11 || inner[0] !== 0x20) return

        // Intercept typed packets before the state-table check.
        // Door: 0x63 = open, 0x4c = close (ST=0x03, not in STATES_VCDWL).
        // 0x8a: periodic snapshot (ST=0x02, not in STATES_VCDWL) — fires ~every 5 min.
        //   inner[23] = elapsed minutes since door-lock (±2 min).
        //   inner[25] = remaining minutes in current phase (wash or rinse).
        //   inner[31] = water/drum temperature (°C), confirmed from Blandmaterial capture.
        const packetType = inner[3]
        if (packetType === 0x63) {
            this.publishProperty('door', 'open')
            return
        }
        if (packetType === 0x4c) {
            this.publishProperty('door', 'closed')
            return
        }
        if (packetType === 0x8a) {
            if (inner.length >= 32) {
                this.publishProperty('elapsed_time', inner[23])
                this.publishProperty('phase_remaining_time', inner[25])
                this.publishProperty('water_temp', inner[31])
            }
            return
        }
        // 0x53: motor-controller ramp packet. inner[12]=0x18 (motor active),
        // inner[13]=speed step 0x12..0x1f. Fires concurrently with 0x76 during
        // tumble AND exclusively during the final drain+spin (0x76 absent for 15+
        // min). Only publish SpinRamp when 0x76 has been silent for >90 s so we
        // don't override the Tumble phase during gentle agitation.
        if (packetType === 0x53) {
            const isActiveSpin = inner.length >= 14 && inner[12] === 0x18 && inner[13] >= 0x12 && inner[13] <= 0x1f
            if (isActiveSpin) {
                const isFinalSpin = Date.now() - this.lastTumbleTime > 90000
                if (isFinalSpin) {
                    this.publishProperty('cycle_phase', 'SpinRamp')
                    this.publishProperty('stage', 'Spinning')
                } else {
                    // Intermediate spin ramp during wash/rinse tumble
                    this.spinRampsSeen++
                    if (this.spinRampsSeen === 1) {
                        // First spin ramp marks end of wash — rinse phase has begun
                        this.publishProperty('stage', 'Rinsing')
                    }
                }
            }
            return
        }

        const st = inner[10]
        const stateLabel = STATES_VCDWL[st]

        // Unknown ST bytes (e.g. 0x4d telemetry bursts) — suppress rather than
        // publishing a garbage label and disrupting the HA sensor.
        if (stateLabel === undefined) return

        const subStart = inner.length >= 32 ? findStatusSubBlock(inner) : -1
        const sub = subStart >= 0 ? inner.subarray(subStart, subStart + 21) : null

        // Post-cycle: ST=Running but phase=Finished (0x0000 or 0x100e both observed).
        // Suppress so End/AntiCrease stays visible in HA.
        if (st === 0xec && sub && decodePhase(sub[1], sub[2]) === 'Finished') return

        // DisplayOn is transient user-browsing; keep the last meaningful state visible.
        // Exception: empty cache or stale 'DisplayOn' retained value → publish Standby
        // so the broker's retained message is corrected.
        if (st !== 0xeb) {
            this.publishProperty('run_state', stateLabel)
        } else {
            const cached = this.getProperty('run_state')
            if (!cached || cached === 'DisplayOn') this.publishProperty('run_state', 'Standby')
        }

        if (st === 0x04 || st === 0xe2) {
            this.publishProperty('remaining_time', 0)
            this.publishProperty('stage', 'Done')
            this.spinRampsSeen = 0
        }

        if (st === 0x0b) {
            this.publishProperty('stage', 'Off')
            this.spinRampsSeen = 0
        }

        if (!sub) return

        const phase = decodePhase(sub[1], sub[2])
        this.publishProperty('cycle_phase', phase)
        this.lastTumbleTime = Date.now()

        if (st === 0xec && phase === 'Tumble' && this.spinRampsSeen === 0) {
            this.publishProperty('stage', 'Washing')
        }

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
        } else if (st === 0xec) {
            const remaining = sub[13] | (sub[14] << 8)
            this.publishProperty('remaining_time', remaining)
        }

        // Extract cycle energy (Wh) from the 10 08 block present in Running packets.
        // Block[+14..+15] = courseSpendPower, big-endian u16.
        const powerBlock = findPowerBlock(inner)
        if (powerBlock >= 0) {
            const courseSpendPower = (inner[powerBlock + 14] << 8) | inner[powerBlock + 15]
            this.publishProperty('course_spend_power', courseSpendPower)
        }
    }

    setProperty(_prop: string, _mqttValue: string) {
        // sensors-only v1; ignore HA writes silently.
    }
}
