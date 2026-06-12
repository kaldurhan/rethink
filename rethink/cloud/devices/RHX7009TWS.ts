import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { DRYER_TABLE } from './stage_fsm'
import log from '@/util/logging'

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

// Course/programme byte (inner[18] for single-block, inner[69] for double-block).
// All 13 panel courses cloud-correlated live during the full programme-knob
// scroll 2026-06-11 19:50 (capture: program-scroll-2026-06-11-*). Cloud names:
// MIXFABRIC, QUICKDRY, WOOL, TURBODRY, SPORTWEAR, AI_COURSE, NORMAL,
// COTTONPLUS (panel "Eko"), DELICATES, EASYCARE, TIMEDRY, ALLERGYCARE,
// TUBCLEAN. The scroll removed five phantom entries (0x0d, 0x1b, 0x1c, 0x26,
// 0x21) and corrected 0x05/0x15 — the panel has exactly these 13. The 0x21
// byte seen in End packets is not a course; program is not read from End
// packets (see processAABB).
const COURSES: Record<number, string> = {
    0x05: 'Easy Care',
    0x06: 'Mixed Fabrics',
    0x07: 'Cotton',
    0x08: 'Sportswear',
    0x09: 'Quick Dry 30',
    0x0a: 'Delicates',
    0x0b: 'Wool',
    0x10: 'Allergy Care',
    0x13: 'Drum Care',
    0x15: 'Timed Dry',
    0x19: 'Eco',
    0x2c: 'AI Dry',
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

// inner[14] in double-block frames — dryness level SETTING. Cloud-correlated
// 2026-06-12 against dryLevel. (The old TR-based decode read programme
// DURATIONS that co-varied with the setting — spec §2.2.)
const DRYNESS_LEVELS: Record<number, string> = {
    0x00: 'None', // courses without a dryness setting (e.g. Timed Dry)
    0x01: 'Damp Dry',
    0x03: 'Iron Dry',
    0x05: 'Very Dry',
}

// inner[15] in double-block frames — ecoHybrid mode setting. Cloud-correlated
// 2026-06-12 against ecoHybrid. 0x00 = field not populated (power-on) — skip.
const ECO_HYBRID: Record<number, string> = {
    0x02: 'Normal',
    0x03: 'Turbo',
}

// ─── Device class ─────────────────────────────────────────────────────────────

export default class Device extends AABBDevice {
    // Last unknown phase tuple already logged — frames repeat every few
    // seconds, so without this gate an unknown tuple floods the add-on log.
    private loggedUnknownTuple = -1

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
                initial_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-initial-time',
                    state_topic: '$this/initial_time',
                    name: 'Programme duration',
                    unit_of_measurement: 'min',
                    icon: 'mdi:timer-sand',
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
                door: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door',
                    state_topic: '$this/door',
                    name: 'Door',
                    device_class: 'door',
                    payload_on: 'open',
                    payload_off: 'closed',
                },
                progress: {
                    platform: 'sensor',
                    unique_id: '$deviceid-progress',
                    state_topic: '$this/progress',
                    name: 'Progress',
                    icon: 'mdi:progress-helper',
                    unit_of_measurement: '%',
                    state_class: 'measurement',
                },
                last_cycle_duration: {
                    platform: 'sensor',
                    unique_id: '$deviceid-last-cycle-duration',
                    state_topic: '$this/last_cycle_duration',
                    name: 'Last cycle duration',
                    icon: 'mdi:history',
                    unit_of_measurement: 'min',
                },
                last_unknown: {
                    platform: 'sensor',
                    unique_id: '$deviceid-last-unknown',
                    state_topic: '$this/last_unknown',
                    name: 'Last unknown code',
                    icon: 'mdi:help-rhombus-outline',
                    entity_category: 'diagnostic',
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

        // 7-byte keepalives (inner = [family, state, seq]) carry the session
        // bit — see AABBDevice.trackKeepalive.
        if (inner.length === 3) {
            this.trackKeepalive(inner[1])
            return
        }

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
        // offsets are unreliable. Info-class ST=0x03 packets carry a code at
        // inner[13], mirrored at inner[17], but the code's meaning depends on
        // the packet shape, keyed by the sub-block length at inner[12]:
        //   0x16 (len 77–81) — user events: 0x0c panel pause, 0x10 idle door,
        //        0x12 cooldown chime; 0x1e (len 85) — 0x0e idle panel event.
        //   0x29 (len 96) — a progress counter that walked 0x07→0x08→0x09
        //        across a live cycle (2026-06-11, door untouched). The 0x07
        //        value was previously misread as a door-open pause code and
        //        flipped run_state/stage to Paused for 1 s mid-Drying.
        // Only a pause code in the user-event shape may publish Paused;
        // everything else is chatter and stays suppressed. 0x07 stays in the
        // pause set (shape-gated) until a real mid-cycle door pause is
        // captured to confirm its code.
        if (isInfoClass) {
            const code = inner.length > 17 && inner[13] === inner[17] ? inner[13] : -1
            const isUserEventShape = inner[12] === 0x16
            // Door event (code 0x10): state at inner[31] — 0x01=open,
            // 0x00=closed. Polarity confirmed mid-cycle 2026-06-12
            // (pause→open→close→resume); the idle test's apparent inversion
            // was a wake artifact — opening a SLEEPING dryer wakes it without
            // a 0x10 event, so that session's first event was a close.
            if (st === 0x03 && isUserEventShape && code === 0x10 && inner.length > 31) {
                this.publishProperty('door', inner[31] === 0x01 ? 'open' : 'closed')
                return
            }
            // Pause: code 0x0c only — confirmed for BOTH panel pause and a
            // real mid-cycle door pause (2026-06-12). The provisional 0x07
            // was the 0x29-shape progress counter misread; dropped.
            if (st === 0x03 && isUserEventShape && code === 0x0c) {
                this.publishProperty('run_state', 'Paused')
                this.stageFsm!.dispatch('paused')
            }
            return
        }

        // Phase is needed before run_state: ST=0xec also broadcasts during
        // programme selection (drum off), where the tuple decodes to Idle or
        // Startup (0x0100 — identical to the first ~8 s of a real cycle).
        let phase: string | null = null
        let phA = 0
        let phB = 0
        let knownPhase = false
        if (inner.length >= 24) {
            phA = hasSub2 ? inner[sub2Start + 13] : inner[14]
            phB = hasSub2 ? inner[sub2Start + 14] : inner[15]
            knownPhase = ((phA << 8) | phB) in PHASES
            phase = decodePhase(phA, phB)
        }
        const isSelection = st === 0xec && phase !== null && (phase === 'Idle' || phase === 'Startup')
        // ST=0xec with an unmapped phase tuple is mid-transition chatter, not
        // proof of drum activity (live 2026-06-11 18:51: the anti-crease tumble
        // broadcast tuple (04,00) with TR=1 five seconds after cycle end,
        // restarting the FSM from Done and producing a duplicate Done edge).
        // Such packets may not claim Running, drive the stage machine, or
        // update remaining_time — phase/program still publish for diagnostics.
        const isUnknownRunning = st === 0xec && phase !== null && !knownPhase

        // DisplayOn (0xeb) and selection chatter are transient user-browsing;
        // keep the last meaningful state. Empty cache or stale 'DisplayOn'
        // retained value → publish Standby so the broker's retained message is
        // corrected. Cost of the selection gate: run_state lags ~8 s at a real
        // cycle start (until the first Heating/Drying packet) — stage drives
        // the automations, so this is cosmetic.
        if (st !== 0xeb && !isSelection && !isUnknownRunning) {
            this.publishProperty('run_state', stateLabel)
        } else {
            const cached = this.getProperty('run_state')
            if (!cached || cached === 'DisplayOn') this.publishProperty('run_state', 'Standby')
        }

        if (st === 0x04 || st === 0xe2) {
            this.publishProperty('remaining_time', 0)
        }

        // Short Running packets carry no phase but only occur mid-cycle.
        if (st === 0xec && inner.length < 24) this.stageFsm!.dispatch('cycleActive')
        // ST=0x03 in a STATUS-class frame is the machine's own Cooldown-done
        // state — observed only at end-of-cycle (every mid-cycle ST=0x03 is
        // info-class and filtered above), so it is treated as end-equivalent
        // and latches Done. If one ever appeared mid-cycle it would latch
        // Done early — no capture has shown that; pinned by test.
        if (st === 0x04 || st === 0xe2 || st === 0x03) this.stageFsm!.dispatch('ended')
        if (st === 0x0b) this.stageFsm!.dispatch('standby')

        // Short/standby packet — leave other properties untouched
        if (inner.length < 24 || phase === null) return

        const csOffset = hasSub2 ? sub2Start + 5 : 18
        const cs = inner[csOffset]

        // End packets (ST=0x04) carry 0x21 at the course offset — not a real
        // course (the panel has exactly 13, all byte-correlated 2026-06-11).
        // Keep the programme that actually ran.
        if (st !== 0x04) {
            this.publishProperty('program', COURSES[cs] ?? `unknown (0x${cs.toString(16).padStart(2, '0')})`)
        }

        // Phase: End/AntiCrease display Finished (washer parity); unknown
        // tuples keep the last value and log once — publishing the raw tuple
        // left 'unknown (3 1)' on the sensor after every cycle.
        if (st === 0x04 || st === 0xe2) {
            this.publishProperty('phase', 'Finished')
        } else if (knownPhase) {
            this.publishProperty('phase', phase)
        } else if (((phA << 8) | phB) !== this.loggedUnknownTuple) {
            log('status', this.id, `unknown phase tuple (0x${phA.toString(16)}, 0x${phB.toString(16)})`)
            this.publishProperty('last_unknown', `phase (0x${phA.toString(16)}, 0x${phB.toString(16)})`)
            this.loggedUnknownTuple = (phA << 8) | phB
        }

        // Settings live at single-block offsets in double-block frames only —
        // 69-byte DisplayOn frames carry zeros there (spec §2.2).
        if (hasSub2) {
            const dryness = DRYNESS_LEVELS[inner[14]]
            if (dryness !== undefined) this.publishProperty('dryness_level', dryness)
            const mode = ECO_HYBRID[inner[15]]
            if (mode !== undefined) this.publishProperty('drying_mode', mode)
        }

        if (st === 0xec && !isUnknownRunning) {
            // Idle (selection display) and Startup (0x0100 — broadcast both
            // while a programme is merely selected AND for the first ~8 s of a
            // real cycle) must not start the stage machine; the first
            // Heating/Drying packet starts the cycle moments later. With
            // unknown tuples gated above, only positively identified active
            // phases reach cycleActive.
            if (phase !== 'Idle' && phase !== 'Startup') {
                // Cycle-start edge: TR still equals the programme duration
                // (= cloud initialTimeMinute, spec §2.2) on the first active
                // frame — capture it for % progress before remaining counts.
                const wasIdle = this.stageFsm!.stage === 'Off' || this.stageFsm!.stage === 'Done'
                this.stageFsm!.dispatch('cycleActive')
                if (wasIdle && tr > 0) this.publishProperty('initial_time', tr)
                // A positively identified active phase implies a closed door
                // (washer parity: closing a sleeping machine's door is silent).
                this.publishProperty('door', 'closed')
            }
            if (phase === 'Heating') this.stageFsm!.dispatch('heatPhase')
            else if (phase === 'Drying') this.stageFsm!.dispatch('dryPhase')
            else if (phase === 'Cooldown' || phase === 'Finishing') this.stageFsm!.dispatch('coolPhase')
        }

        // TR while running = minutes remaining. While ST=0xeb/selection it is
        // the programme duration (captured as initial_time at cycle start);
        // dryness/mode decode from inner[14]/[15] above — the old TR-based
        // dryness/mode decode read durations, not settings (spec §2.2).
        if (st === 0xec && !isUnknownRunning) {
            this.publishProperty('remaining_time', tr)
        }
        // ST=0xe2 (AntiCrease) or 0x04 (End): TR not published
    }
}
