import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { WASHER_TABLE } from './stage_fsm'
import log from '@/util/logging'

// inner[10] — run state.
const STATES_VCDWL: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Running',
    0x04: 'End',
    0xe2: 'AntiCrease',
}

// sub[4] — course code. sub[5] is always 0x00 (the LE high byte).
// All 15 entries cloud-correlated live during the full programme-knob scroll
// 2026-06-11 19:40 (capture: program-scroll-2026-06-11-*). Cloud names:
// MIX, TURBO39, SPORTS_WEARS, TUB_CLEAN, SPEED14, WOOL, NORMAL, AI_COURSE,
// COTTONECO, DELICATES, EASYCARE, MICROPLASTIC_CARE, ALLERGY_SPASTEAM,
// RINSE_SPIN, SPIN_ONLY.
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
    0x37: 'Sköljning + Centrifugering',
    0x4e: 'Centrifugering',
}

// sub[1] (phA) — temperature index (programme-agnostic).
// Confirmed by correlating cloud MQTT temp fields with binary phA values
// across the Cotton temp-scroll (Cold→20→30→40→60→95→Cold).
const TEMPERATURES_VCDWL: Record<number, string> = {
    0x08: 'Cold',
    0x01: '20',
    0x02: '30',
    0x03: '40',
    0x05: '60',
    0x06: '95',
}

// Stages during which the course cannot legitimately change (panel locks
// the dial once a cycle runs).
const ACTIVE_WASHER_STAGES = new Set(['Washing', 'Rinsing', 'Spinning', 'Paused'])

// sub[3] — spin-speed code. All six wheel positions cloud-correlated live
// during the 2026-06-12 spin-button scroll (capture: cycle-2026-06-12-*):
// two full wheel revolutions, binary↔cloud transitions paired 1:1 plus
// course-default cross-checks. The previous map was shifted two wheel
// positions (it read 0x06 as 400; the true value is 1000). 0x27 (transient
// during drain) is NOT a panel setting and stays unmapped — unknown codes
// keep the last published value.
const SPINS_VCDWL: Record<number, number> = {
    0x01: 400,
    0x04: 800,
    0x06: 1000,
    0x08: 1200,
    0x09: 1400,
    0x0c: 0, // "drain only" wheel position (SPIN_DRAIN_ONLY)
}

// (sub[1] << 8) | sub[2] — display tuple. Only used to gate temperature
// publishing: these codes mean "panel idle / settled display", where
// sub[1] carries the temperature index. The tuple is NOT a cycle phase —
// it freezes for entire cycles (2026-06-11 spec).
const DISPLAY_IDLE_VCDWL = new Set([
    // settled temp displays (0x0110 is the scroll-in-progress code — temp
    // must NOT publish until the display settles, hence excluded)
    0x0210,
    0x0310,
    0x0510,
    0x0810,
    0x0610,
    0x010e,
    0x020e,
    0x030e,
    0x050e, // programme-selection browsing
])

// sub[20] — drum-activity / block-type code; sub[21] echoes the previous
// code. Milestone sequence confirmed across Eco 40-60 + Quick 14
// (2026-06-11): 01(selected) → 03 → 26 → 02 → 0b(wash, 26↔0b refills)
// → 0c(rinse) → 0e(drain+spin) → 10(finished) → 00(post-cycle idle).
// 03/26/02 labels are best-guess — confirm against the next live cycle.
const ACTIVITY_VCDWL: Record<number, string> = {
    0x00: 'Idle',
    0x01: 'Idle',
    0x03: 'Detecting',
    0x26: 'Filling',
    0x02: 'Washing',
    0x0b: 'Washing',
    0x0c: 'Rinsing',
    0x0e: 'Spinning',
    0x10: 'Finished',
}

// Activity codes during which the drum tumbles — the only ones that may
// refresh lastTumbleTime (the 0x53 final-spin gate depends on tumble
// silence; spin packets must not reset it).
const TUMBLE_ACTIVITY = new Set([0x03, 0x26, 0x02, 0x0b, 0x0c])

// Passive blocks: drum not actively cycling. 0x01 = programme selection /
// temp scroll, 0x10 = post-cycle anti-wrinkle tumble, 0x00 = post-cycle
// idle. While ST=0xec these must not claim Running or start the stage
// machine. (Replaces the old display-tuple Finished suppression, which
// also ate LIVE final-spin packets — they share disp=(00,00).)
const PASSIVE_ACTIVITY = new Set([0x00, 0x01, 0x10])

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
 *   [1]  PH_A (temperature index)   [2]  PH_B   [3] spin   [4] course
 *   [5]  0x00 (anchor)              [13] remaining_time_lo  [14] remaining_time_hi
 *   [15] initial_time_lo            [19] course (repeated — anchor)
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

        if (inner[i + 19] !== cs) continue

        // Guard A (2026-06-11 spec): the 114-byte packet variant fakes a
        // valid-looking block whose remaining-time field is absurd
        // (2304 min observed; legit blocks max 152). No programme exceeds
        // 6 h — reject and keep scanning, which recovers the true block.
        const rem = inner[i + 13] | (inner[i + 14] << 8)
        if (rem > 360) continue

        return i
    }
    return -1
}

export default class Device extends AABBDevice {
    // Timestamp of the last tumble-class 0x76 sub-block decode (see
    // TUMBLE_ACTIVITY). Gates the 0x53 final-spin heuristic: during active
    // tumble, 0x76 fires every ~60 s so this stays fresh; during the final
    // drain+spin no tumble packet arrives for 15+ min, so a 0x53 ramp after
    // >90 s of silence dispatches the stage spinPhase event.
    lastTumbleTime = 0
    // Count of intermediate spin-ramp events seen in the current cycle.
    // 0 = still in wash phase; ≥1 = rinse phase has begun.
    spinRampsSeen = 0
    // Last unmapped course/phase codes already logged — packets repeat every few
    // seconds, so without this gate an unknown code floods the add-on log.
    private loggedUnknownCourse = -1
    private loggedMispickCourse = -1
    private loggedUnknownActivity = -1
    private loggedUnknownSpin = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const courseOptions = [...Object.values(COURSES_VCDWL), 'unknown']
        const phaseOptions = ['Idle', 'Detecting', 'Filling', 'Washing', 'Rinsing', 'Spinning', 'Finished', 'unknown']
        this.setConfig({
            ...HADevice.config(meta, { name: 'LG F4X7511TWS' }),
            components: {
                run_state: {
                    platform: 'sensor',
                    unique_id: '$deviceid-run_state',
                    state_topic: '$this/run_state',
                    name: 'Run state',
                    icon: 'mdi:power',
                    device_class: 'enum',
                    options: ['Standby', 'Running', 'Paused', 'End', 'AntiCrease'],
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
                    options: ['Cold', '20', '30', '40', '60', '95', 'unknown'],
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
                    options: ['Off', 'Paused', 'Washing', 'Rinsing', 'Spinning', 'Done'],
                },
            },
        })
        this.initStageFSM(WASHER_TABLE)
    }

    start() {
        this.publishProperty('stage', this.stageFsm!.stage)
    }

    processAABB(inner: Buffer) {
        if (inner.length < 11 || inner[0] !== 0x20) return

        // inner[3] is the FRAME-LENGTH byte (total frame size & 0xff), not a
        // packet type — verified over 9.6k frames across all captures
        // (2026-06-12). The two intercepts below key on it because those
        // lengths are unique in practice; real packet identity lives in the
        // info-class shape constants at inner[12..13].
        //
        // 138-byte frame (0x8a): periodic snapshot (ST=0x02, not in
        // STATES_VCDWL) — fires ~every 5 min.
        //   inner[23] = elapsed minutes since door-lock (±2 min).
        //   inner[25] = remaining minutes in current phase (wash or rinse).
        //   inner[31] = water/drum temperature (°C), confirmed from Blandmaterial capture.
        const frameLen = inner[3]
        if (frameLen === 0x8a) {
            if (inner.length >= 32) {
                this.publishProperty('elapsed_time', inner[23])
                this.publishProperty('phase_remaining_time', inner[25])
                this.publishProperty('water_temp', inner[31])
            }
            return
        }
        // 83-byte frame (0x53): motor-controller ramp. inner[12]=0x18 (motor
        // active), inner[13]=speed step 0x12..0x1f. Fires concurrently with
        // status packets during tumble AND exclusively during the final
        // drain+spin (status tumble absent for 15+ min). The >90 s
        // tumble-silence gate distinguishes the final spin (stage spinPhase)
        // from intermediate ramps (first one = rinse began). cycle_phase
        // itself is published from the activity codes in the status path —
        // this packet only drives stage events.
        if (frameLen === 0x53) {
            const isActiveSpin = inner.length >= 14 && inner[12] === 0x18 && inner[13] >= 0x12 && inner[13] <= 0x1f
            if (isActiveSpin) {
                const isFinalSpin = Date.now() - this.lastTumbleTime > 90000
                if (isFinalSpin) {
                    this.stageFsm!.dispatch('spinPhase')
                } else {
                    // Intermediate spin ramp during wash/rinse tumble
                    this.spinRampsSeen++
                    if (this.spinRampsSeen === 1) {
                        // First spin ramp marks end of wash — rinse phase has begun
                        this.stageFsm!.dispatch('rinsePhase')
                    }
                }
            }
            return
        }

        // Door events arrive as 65-byte info-class frames: shape
        // inner[12]=0x06, event code inner[13]=0x10 (the same code the dryer
        // uses for its door event), door state at inner[18]: 0x01=open,
        // 0x02=closed. Cloud-correlated 2026-06-12 — seven alternating
        // open/close events plus the doorLock follow-up after remote-start
        // arming. The former decode keyed on inner[3]=0x63/0x4c, i.e. on
        // 99/76-byte frame LENGTHS, and read "open" from unrelated telemetry
        // through entire cycles.
        if (inner.length >= 19 && inner[8] === 0x02 && inner[10] === 0x03 && inner[12] === 0x06 && inner[13] === 0x10) {
            if (inner[18] === 0x01) this.publishProperty('door', 'open')
            else if (inner[18] === 0x02) this.publishProperty('door', 'closed')
            return
        }

        // Wake event ([13]=0x11) with cause 0x04 = woken by door open: the
        // FIRST door open from sleep arrives as this event instead of a
        // [13]=0x10 door event (asleep-door test, 2026-06-12). Without it the
        // sensor misses every initial open after the panel times out.
        if (inner.length >= 19 && inner[8] === 0x02 && inner[10] === 0x03 && inner[12] === 0x06 && inner[13] === 0x11) {
            if (inner[18] === 0x04) this.publishProperty('door', 'open')
            return
        }

        // Info-class status packets (inner[8]=0x02, ST=0x03) carry a sub-state
        // code at inner[13], mirrored at inner[17]: 0x11 idle-browse, 0x1e
        // pre-detect, 0x01 detecting, 0x0b detergent input, 0x0c pause
        // (correlated with cloud state PAUSE, captured 2026-06-11). Only 0x0c
        // is a pause — the others occur during a normal running cycle, so a
        // blanket ST=0x03→Paused mapping (the dryer's rule) would be wrong here.
        if (inner.length >= 18 && inner[8] === 0x02 && inner[10] === 0x03 && inner[13] === 0x0c && inner[17] === 0x0c) {
            this.publishProperty('run_state', 'Paused')
            this.stageFsm!.dispatch('paused')
            return
        }

        const st = inner[10]
        const stateLabel = STATES_VCDWL[st]

        // Unknown ST bytes (e.g. 0x4d telemetry bursts) — suppress rather than
        // publishing a garbage label and disrupting the HA sensor.
        if (stateLabel === undefined) return

        const subStart = inner.length >= 32 ? findStatusSubBlock(inner) : -1
        const sub = subStart >= 0 ? inner.subarray(subStart, subStart + 21) : null

        // Passive blocks (selection / post-cycle, see PASSIVE_ACTIVITY) must
        // not claim Running or start the stage machine; their course/phase
        // still publish below. Short packets (no sub-block) only occur
        // mid-cycle. (Replaces the old display-tuple Finished suppression —
        // disp=(00,00) also appears on LIVE final-spin packets, so keying on
        // it froze remaining_time/run_state through every spin.)
        const isPassiveBlock = st === 0xec && sub !== null && PASSIVE_ACTIVITY.has(sub[20])

        if (st !== 0xeb && !isPassiveBlock) {
            this.publishProperty('run_state', stateLabel)
            // A running drum physically implies a closed door. Closing the
            // door of a SLEEPING machine emits no event (only opening wakes
            // it — live 2026-06-12), so without this inference the door
            // sensor sticks at 'open' through entire cycles.
            if (st === 0xec) this.publishProperty('door', 'closed')
            if (st === 0xec) this.stageFsm!.dispatch('cycleActive')
            if (st === 0x04 || st === 0xe2) this.stageFsm!.dispatch('ended')
            if (st === 0x0b) this.stageFsm!.dispatch('standby')
        } else {
            // DisplayOn and selection chatter are transient user-browsing —
            // keep the last meaningful state visible. Empty cache or stale
            // 'DisplayOn' retained value → publish Standby so the broker's
            // retained message is corrected.
            const cached = this.getProperty('run_state')
            if (!cached || cached === 'DisplayOn') this.publishProperty('run_state', 'Standby')
        }

        if (st === 0x04 || st === 0xe2) {
            this.publishProperty('remaining_time', 0)
            this.spinRampsSeen = 0
        }

        if (st === 0x0b) {
            this.spinRampsSeen = 0
        }

        if (!sub) return

        // Guard B (2026-06-11 spec): the 114-byte packet variant can fake a
        // block that passes Guard A (rem=256 observed live mid-Eco). A
        // mid-cycle block claiming a different course than the one running
        // is physically impossible — the panel locks the dial — so discard
        // the whole sub-block; every sensor keeps its value.
        const blkCourseLabel = COURSES_VCDWL[sub[4]] ?? 'unknown'
        const runningCourse = this.getProperty('course')
        if (
            ACTIVE_WASHER_STAGES.has(this.stageFsm!.stage) &&
            runningCourse !== undefined &&
            blkCourseLabel !== runningCourse
        ) {
            if (sub[4] !== this.loggedMispickCourse) {
                log(
                    'status',
                    this.id,
                    `discarding mis-picked sub-block (course 0x${sub[4].toString(16).padStart(2, '0')} while running ${runningCourse})`,
                )
                this.loggedMispickCourse = sub[4]
            }
            return
        }

        // cycle_phase from the drum-activity code (2026-06-11 spec). The
        // display tuple sub[1..2] freezes for whole cycles and is only used
        // for the temperature gate below.
        if (st === 0xe2) {
            this.publishProperty('cycle_phase', 'Finished')
        } else {
            const activity = ACTIVITY_VCDWL[sub[20]]
            if (activity !== undefined) {
                this.publishProperty('cycle_phase', activity)
            } else if (sub[20] !== this.loggedUnknownActivity) {
                log('status', this.id, `unknown activity code 0x${sub[20].toString(16).padStart(2, '0')}`)
                this.loggedUnknownActivity = sub[20]
            }
        }
        // Only tumble-class activity refreshes the tumble timestamp — the
        // 0x53 final-spin gate ("no 0x76 tumble for >90 s") depends on spin
        // packets NOT resetting it.
        if (TUMBLE_ACTIVITY.has(sub[20])) this.lastTumbleTime = Date.now()

        // Unknown spin bytes (e.g. transient 0x27 during drain) keep the last
        // published value — they are not wheel settings.
        const sp = sub[3]
        const spinRpm = SPINS_VCDWL[sp]
        if (spinRpm !== undefined) {
            this.publishProperty('spin', spinRpm)
        } else if (sp !== this.loggedUnknownSpin) {
            log('status', this.id, `unknown spin byte 0x${sp.toString(16).padStart(2, '0')}`)
            this.loggedUnknownSpin = sp
        }

        const cs = sub[4]
        const courseLabel = COURSES_VCDWL[cs]
        if (courseLabel === undefined && cs !== this.loggedUnknownCourse) {
            log('status', this.id, `unknown course byte 0x${cs.toString(16).padStart(2, '0')}`)
            this.loggedUnknownCourse = cs
        }
        // 'unknown' is in the enum options list; a dynamic label would be
        // rejected by HA's enum validation.
        this.publishProperty('course', courseLabel ?? 'unknown')

        // Only publish temp from temp-scroll sub-blocks (marker 0x05,
        // selection activity 0x01) whose display tuple is a settled/browse
        // code — there sub[1] carries the temperature index.
        const subMarker = inner[subStart]
        if (subMarker === 0x05 && sub[20] === 0x01 && DISPLAY_IDLE_VCDWL.has((sub[1] << 8) | sub[2])) {
            this.publishProperty('temp', TEMPERATURES_VCDWL[sub[1]] ?? 'unknown')
        } else if (st === 0xec && sub[20] !== 0x10 && sub[20] !== 0x00) {
            // Post-cycle blocks (act 0x10/0x00) carry a leftover rem=1 and
            // would blip remaining_time off the End-reset 0 (live 2026-06-12).
            // Selection blocks (act 0x01) still publish — browsing shows the
            // programme duration.
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
