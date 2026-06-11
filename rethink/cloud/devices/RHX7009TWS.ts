import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { DRYER_TABLE } from './stage_fsm'

// ─── Lookup tables ────────────────────────────────────────────────────────────

// inner[10] — machine state
const STATES: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Running',
    0x03: 'Cooldown',
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
    0x1b: 'Strykfritt',
    0x1c: 'Eco',
    0x21: 'Auto Dry', // observed only in End packet; exact name unconfirmed
    0x26: 'AI Dry',
    0x3a: 'TurboDry',
}

// Phase tuple encoded as (phA << 8) | phB.
// Note: actual captures show [07 01] for Drying (not [07 09] as in older docs).
const PHASES: Record<number, string> = {
    0x0503: 'Idle',
    0x0309: 'Heating',
    0x0307: 'Heating', // transient variant seen immediately after resume
    0x0100: 'Startup', // brief init phase at cycle start (~8 s before heating begins)
    0x0701: 'Drying',
    0x0703: 'Drying', // transient variant seen immediately after resume
    0x0710: 'Cooldown',
    0x0711: 'Cooldown', // sustained cooldown-tumble (cool air, no heat) — dominant end-of-drying phase
    0x1100: 'Finishing', // very brief transition at TR=2 just before drum stops
    0x0811: 'Finishing', // final pre-anti-crease phase, TR=1, ~3 min
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
        this.setConfig({
            ...HADevice.config(meta, { name: 'LG RHX7009TWS Dryer' }),
            components: {
                run_state: {
                    platform: 'sensor',
                    unique_id: '$deviceid-run-state',
                    state_topic: '$this/run_state',
                    name: 'Run state',
                    icon: 'mdi:state-machine',
                    device_class: 'enum',
                    options: ['Standby', 'Running', 'Paused', 'Cooldown', 'AntiCrease', 'End'],
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
                stage: {
                    platform: 'sensor',
                    unique_id: '$deviceid-stage',
                    state_topic: '$this/stage',
                    name: 'Stage',
                    icon: 'mdi:tumble-dryer',
                    device_class: 'enum',
                    options: ['Off', 'Paused', 'Heating', 'Drying', 'Cooling', 'Done'],
                },
            },
        })
        this.initStageFSM(DRYER_TABLE)
    }

    start() {
        this.publishProperty('stage', this.stageFsm!.stage)
    }

    processAABB(inner: Buffer) {
        // Frame-type guard
        if (inner[0] !== 0x30) return

        // Too short to read ST at inner[10]
        if (inner.length < 11) return

        const st = inner[10]
        const stateLabel = STATES[st]

        // Unknown ST bytes are transient telemetry or init packets — skip rather
        // than publishing a garbage label and disrupting the HA sensor.
        if (stateLabel === undefined) return

        // Info-class packets (inner[8]=0x02) have a 9-byte header; CS/TR/phase
        // offsets are wrong for that format — only ST is reliable.
        const isInfoClass = inner[8] === 0x02

        // ── Determine sub-block offsets ───────────────────────────────────────
        // Double-block packets (inner.length >= 116) carry two sub-blocks.
        // The second sub-block is always 52 bytes, but the first sub-block
        // length varies (64 or 65 bytes depending on packet state), so we
        // locate sub2 dynamically by scanning for the first sub-block's
        // footer signature: 64 00 04 00 78 [00 00 00].
        //
        // Field offsets relative to sub2Start:
        //   CS=+5, TR=+10, phA=+13, phB=+14
        //
        // Single-block: CS=inner[18], TR=inner[23], phase=inner[14,15]
        let sub2Start = -1
        if (!isInfoClass && inner.length >= 116) {
            for (let i = 54; i <= 66 && i + 7 < inner.length; i++) {
                if (inner[i] === 0x64 && inner[i + 2] === 0x04 && inner[i + 4] === 0x78) {
                    sub2Start = i + 8
                    break
                }
            }
        }
        const hasSub2 = sub2Start > 0 && sub2Start + 14 < inner.length
        const trOffset = hasSub2 ? sub2Start + 10 : 23
        const tr = inner.length >= 24 && trOffset < inner.length ? inner[trOffset] : 0

        // Running with TR=0 is the post-cycle anti-wrinkle tumble — the drying
        // program finished but the drum keeps spinning. Keep End displayed until
        // Standby/DisplayOn arrives.
        if (st === 0xec && tr === 0) return

        // Info-class packets (inner[8]=0x02) use a different byte layout — CS/TR/phase
        // offsets are unreliable. Info-class ST=0x03 packets carry a sub-state
        // code at inner[13], mirrored at inner[17] (same layout as the washer):
        // 0x0c = panel pause, 0x07 = mid-cycle door-open pause, 0x10 = idle
        // door event, 0x0e = idle panel event (live-captured 2026-06-11).
        // Only the real pause codes may publish Paused; everything else is
        // idle chatter and stays suppressed.
        if (isInfoClass) {
            const code = inner.length > 17 && inner[13] === inner[17] ? inner[13] : -1
            if (st === 0x03 && (code === 0x0c || code === 0x07)) {
                this.publishProperty('run_state', 'Paused')
                this.stageFsm!.dispatch('paused')
            }
            return
        }

        // DisplayOn (0xeb) is transient user-browsing; keep the last meaningful state.
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
        }

        // cycleActive for full Running packets is dispatched below, after the
        // phase decode: ST=0xec also broadcasts during programme selection
        // (drum off, phase Idle) and must not start the stage machine. Short
        // Running packets carry no phase but only occur mid-cycle.
        if (st === 0xec && inner.length < 24) this.stageFsm!.dispatch('cycleActive')
        if (st === 0x04 || st === 0xe2 || st === 0x03) this.stageFsm!.dispatch('ended')
        if (st === 0x0b) this.stageFsm!.dispatch('standby')

        // Short/standby packet — leave other properties untouched
        if (inner.length < 24) return

        const csOffset = hasSub2 ? sub2Start + 5 : 18
        const cs = inner[csOffset]

        let phA: number
        let phB: number
        if (hasSub2) {
            phA = inner[sub2Start + 13]
            phB = inner[sub2Start + 14]
        } else {
            phA = inner[14]
            phB = inner[15]
        }

        this.publishProperty('program', COURSES[cs] ?? `unknown (0x${cs.toString(16).padStart(2, '0')})`)
        const phase = decodePhase(phA, phB)
        this.publishProperty('phase', phase)

        if (st === 0xec) {
            // Idle (selection display) and Startup (0x0100 — broadcast both
            // while a programme is merely selected AND for the first ~8 s of a
            // real cycle) must not start the stage machine; the first
            // Heating/Drying packet starts the cycle moments later.
            if (phase !== 'Idle' && phase !== 'Startup') this.stageFsm!.dispatch('cycleActive')
            if (phase === 'Heating') this.stageFsm!.dispatch('heatPhase')
            else if (phase === 'Drying') this.stageFsm!.dispatch('dryPhase')
            else if (phase === 'Cooldown' || phase === 'Finishing') this.stageFsm!.dispatch('coolPhase')
        }

        // TR interpretation is ST-dependent
        if (st === 0xec) {
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
