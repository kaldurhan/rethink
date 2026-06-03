import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { allowExtendedType } from '@/util/casting'

// ─── Lookup tables ────────────────────────────────────────────────────────────

// inner[10] — machine state
const STATES: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Running',
    0xe2: 'AntiCrease',
    0x04: 'End',
}

// Course/programme byte (inner[18] for single-block, inner[69] for double-block)
const COURSES: Record<number, string> = {
    0x05: 'Timed Dry',
    0x06: 'Mixed Fabrics',
    0x07: 'Cotton',
    0x08: 'Sportswear',
    0x09: 'Quick Dry 30',
    0x0a: 'Delicates',
    0x0b: 'Wool',
    0x0d: 'Easy Iron',
    0x13: 'Drum Care',
    0x15: 'Allergy Care',
    0x1b: 'Easy Iron',
    0x1c: 'Eco',
    0x26: 'AI Dry',
    0x3a: 'TurboDry',
}

// Phase tuple encoded as (phA << 8) | phB.
// Note: actual captures show [07 01] for Drying (not [07 09] as in older docs).
const PHASES: Record<number, string> = {
    0x0503: 'Idle',
    0x0309: 'Heating',
    0x0701: 'Drying',
    0x0710: 'Cooldown',
}

function decodePhase(phA: number, phB: number): string {
    return PHASES[(phA << 8) | phB] ?? `unknown (${phA.toString(16)} ${phB.toString(16)})`
}

// TR byte when ST=0xeb and phA=0x05 — dryness level
const DRYNESS: Record<number, string> = {
    0x1e: 'Iron Dry',
    0x41: 'Cupboard Dry',
    0x46: 'Extra Dry',
}

// TR byte when ST=0xeb and phA≠0x05 — drying mode
const DRYING_MODE: Record<number, string> = {
    0x46: 'Efficiency',
    0x96: 'Turbo',
}

// ─── Device class ─────────────────────────────────────────────────────────────

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG RHX7009TWS Dryer' }),
                components: {
                    run_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-run-state',
                        state_topic: '$this/run_state',
                        name: 'Run state',
                        icon: 'mdi:state-machine',
                    },
                    program: {
                        platform: 'sensor',
                        unique_id: '$deviceid-program',
                        state_topic: '$this/program',
                        name: 'Program',
                        icon: 'mdi:tumble-dryer',
                    },
                    phase: {
                        platform: 'sensor',
                        unique_id: '$deviceid-phase',
                        state_topic: '$this/phase',
                        name: 'Phase',
                        icon: 'mdi:progress-clock',
                    },
                    dryness_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryness-level',
                        state_topic: '$this/dryness_level',
                        name: 'Dryness level',
                        icon: 'mdi:water-percent',
                    },
                    drying_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-drying-mode',
                        state_topic: '$this/drying_mode',
                        name: 'Drying mode',
                        icon: 'mdi:leaf',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: 'Time remaining',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
                    },
                },
            }),
        )
    }

    processAABB(inner: Buffer) {
        // Frame-type guard
        if (inner[0] !== 0x30) return

        // Too short to read ST at inner[10]
        if (inner.length < 11) return

        const st = inner[10]
        this.publishProperty('run_state', STATES[st] ?? `unknown (${st.toString(16)})`)

        // Short/standby packet — leave other properties untouched
        if (inner.length < 24) return

        // ── Determine sub-block offsets ───────────────────────────────────────
        // 116-byte double-block packets carry the live selection in the second
        // sub-block starting at inner[64]; all shorter packets use inner[0].
        //
        // Field absolute offsets:
        //   single-block: CS=inner[18], TR=inner[23], phase=inner[14,15]
        //   double-block: CS=inner[69], TR=inner[74], phase=inner[77,78]
        //   COOLDOWN-type (inner[8]=0x02): phase=inner[13,14] (9-byte header)
        const hasSub2 = inner.length >= 116
        const csOffset = hasSub2 ? 69 : 18
        const trOffset = hasSub2 ? 74 : 23

        let phA: number
        let phB: number
        if (inner[8] === 0x02) {
            // Info-class packet has a 9-byte header instead of 10
            phA = inner[13]
            phB = inner[14]
        } else if (hasSub2) {
            phA = inner[77]
            phB = inner[78]
        } else {
            phA = inner[14]
            phB = inner[15]
        }

        const cs = inner[csOffset]
        const tr = trOffset < inner.length ? inner[trOffset] : 0

        this.publishProperty('program', COURSES[cs] ?? `unknown (0x${cs.toString(16).padStart(2, '0')})`)
        this.publishProperty('phase', decodePhase(phA, phB))

        // TR interpretation is ST-dependent
        if (st === 0xec) {
            // Running: TR = remaining minutes
            this.publishProperty('remaining_time', tr)
        } else if (st === 0xeb) {
            // DisplayOn: phA=0x05 → dryness level; otherwise → drying mode
            if (phA === 0x05) {
                this.publishProperty('dryness_level', DRYNESS[tr] ?? `unknown (0x${tr.toString(16)})`)
            } else {
                this.publishProperty('drying_mode', DRYING_MODE[tr] ?? `unknown (0x${tr.toString(16)})`)
            }
        }
        // ST=0xe2 (AntiCrease) or 0x04 (End): TR not published
    }
}
