// base implementation for devices with a AA...BB payload format
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { StageFSM, type Stage, type TransitionTable } from './stage_fsm'
import { loadStageState, saveStageState } from './stage_store'
import { captureDevice } from '@/util/capture'
import log from '@/util/logging'

// Consecutive asleep-keepalives required before forcing Standby (~20 s at
// the 2 s keepalive cadence). One transient 0xe8 was observed mid-session
// (2026-06-12 11:05:18) — the streak absorbs such blips.
const KEEPALIVE_ASLEEP_STREAK = 10

// A healthy machine streams keepalives every ~2 s at ALL times (asleep
// included). Silence beyond this means the TLS session is half-open — the
// failure mode that left stale values in HA for hours on 2026-06-12 while
// the broker still reported the session "online".
const SILENCE_OFFLINE_MS = 150_000

// Stages that mean a cycle is physically underway (used for the cycle
// summary timer; Paused intentionally excluded so pauses count into the
// total duration).
const ACTIVE_STAGES = new Set<Stage>(['Washing', 'Rinsing', 'Spinning', 'Heating', 'Drying', 'Cooling'])

export default abstract class AABBDevice extends HADevice {
    publishCache: Record<string, string | number> = {}

    private offTimer: ReturnType<typeof setTimeout> | null = null
    private asleepStreak = 0
    protected stageFsm: StageFSM | null = null

    /**
     * Keepalive session bit: the 7-byte keepalive frames carry 0xe9 (session
     * active) / 0xe8 (asleep) at inner[1]. Verified across all 2026-06-12
     * captures on both machines: 0xe8 never appears during an active session
     * (0 of ~3,300 keepalives in a 100-min wash) and returns ~90 s after the
     * panel sleeps. After KEEPALIVE_ASLEEP_STREAK consecutive 0xe8 frames the
     * machine is confirmed asleep: publish Standby and drive the stage FSM to
     * Off. This corrects post-cycle states (End/AntiCrease) left stale by a
     * missed Standby frame or by an MQTT retained value restored after an
     * add-on restart — an asleep machine emits nothing but keepalives for
     * hours, so without this there is no correcting signal.
     * Other keepalive state bytes (one-off event values 0x19/0xd8/0xc3/0x7f)
     * reset the streak and do nothing else.
     */
    protected trackKeepalive(state: number) {
        if (state !== 0xe8) {
            this.asleepStreak = 0
            return
        }
        this.asleepStreak++
        if (this.asleepStreak === KEEPALIVE_ASLEEP_STREAK) {
            this.publishProperty('run_state', 'Standby')
            this.stageFsm?.dispatch('standby')
        }
    }

    // Timestamp of the first active-stage entry of the current cycle; null
    // outside cycles (and after a mid-cycle add-on restart, where the start
    // time is unknown — the summary is skipped for that cycle).
    private cycleStartedAt: number | null = null

    // Call from subclass constructor. Restores persisted stage, publishes it on
    // start(), and centralizes the Done→Off fallback timer + cycle summary.
    protected initStageFSM(table: TransitionTable) {
        const persisted = loadStageState()[this.thinq.id]
        const initial = persisted?.stage ?? 'Off'
        this.stageFsm = new StageFSM(this.thinq.id, table, initial, (stage) => {
            this.publishProperty('stage', stage)
            saveStageState(this.thinq.id, {
                stage,
                since: Date.now(),
                lastDoneAt: stage === 'Done' ? Date.now() : (loadStageState()[this.thinq.id]?.lastDoneAt ?? null),
            })
            if (ACTIVE_STAGES.has(stage) && this.cycleStartedAt === null) {
                this.cycleStartedAt = Date.now()
            }
            if (stage === 'Done') this.publishProperty('progress', 100)
            else if (stage === 'Off') this.publishProperty('progress', 0)
            else this.updateProgress()
            if (stage === 'Done') {
                // End-of-cycle summary: duration from the cycle-start edge,
                // energy from the device's own cycle counter when it has one.
                if (this.cycleStartedAt !== null) {
                    this.publishProperty('last_cycle_duration', Math.round((Date.now() - this.cycleStartedAt) / 60000))
                }
                const energy = this.publishCache['course_spend_power']
                if (energy !== undefined) this.publishProperty('last_cycle_energy', energy)
                this.cycleStartedAt = null
                this.scheduleOff()
            } else {
                if (stage === 'Off') this.cycleStartedAt = null
                this.cancelOffTimer()
            }
        })
    }

    // Frame-silence availability watchdog (see SILENCE_OFFLINE_MS).
    private lastFrameAt = Date.now()
    private silenceOffline = false
    private silenceTimer: ReturnType<typeof setInterval>

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data) => this.processData(data))
        this.silenceTimer = setInterval(() => this.checkSilence(), 60_000)
        this.silenceTimer.unref()
        thinq.on('close', () => clearInterval(this.silenceTimer))
    }

    // Half-open TLS sessions deliver no frames but never fire 'close' — mark
    // the device unavailable so HA shows the truth instead of stale values.
    // Exposed (with injectable clock) for tests.
    checkSilence(now = Date.now()) {
        if (!this.silenceOffline && now - this.lastFrameAt > SILENCE_OFFLINE_MS) {
            this.silenceOffline = true
            log(
                'status',
                `${this.id}: no frames for ${Math.round((now - this.lastFrameAt) / 1000)} s — marking unavailable`,
            )
            this.HA.publishProperty(this.id, 'availability', 'offline')
        }
    }

    // sends a packet of the format:
    // AA [length] ...inner [checksum] BB
    send(inner: Buffer) {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])])
        const sum = packet.reduce((pv, cv) => pv + cv, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        packet[packet.length - 1] = 0xbb
        this.thinq.send_packet(packet)
    }

    processData(buf: Buffer) {
        captureDevice(this.thinq.id, buf)
        this.lastFrameAt = Date.now()
        if (this.silenceOffline) {
            this.silenceOffline = false
            log('status', `${this.id}: frames resumed — marking available`)
            this.HA.publishProperty(this.id, 'availability', 'online')
        }
        if (buf.length >= 4 && buf[0] == 0xaa && buf[buf.length - 1] == 0xbb) {
            this.processAABB(buf.subarray(2, buf.length - 2))
        }
    }

    abstract processAABB(buf: Buffer): void

    // to be called by processAABB
    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
        if (prop === 'remaining_time' || prop === 'initial_time') this.updateProgress()
    }

    // Native % progress from initial_time vs remaining_time while a cycle is
    // underway (Paused included — progress holds rather than resets). Done
    // pins 100, Off pins 0 (see initStageFSM).
    private updateProgress() {
        const stage = this.stageFsm?.stage
        if (!stage || (!ACTIVE_STAGES.has(stage) && stage !== 'Paused')) return
        const total = this.publishCache['initial_time']
        const left = this.publishCache['remaining_time']
        if (typeof total !== 'number' || typeof left !== 'number' || total <= 0) return
        this.publishProperty('progress', Math.max(0, Math.min(100, Math.round((100 * (total - left)) / total))))
    }

    getProperty(prop: string): string | number | undefined {
        return this.publishCache[prop]
    }

    // Publish 'Off' to the stage property after a delay. If a Standby packet or
    // a new active cycle arrives first, cancelOffTimer() prevents the publish.
    protected scheduleOff(delayMs = 5 * 60 * 1000) {
        if (this.offTimer !== null) clearTimeout(this.offTimer)
        this.offTimer = setTimeout(() => {
            this.offTimer = null
            if (this.stageFsm) this.stageFsm.dispatch('offTimeout')
            else this.publishProperty('stage', 'Off')
        }, delayMs)
        // unref so lingering Done→Off fallbacks never hold the process open
        // (the daemon is kept alive by its sockets; tests exit cleanly)
        this.offTimer.unref()
    }

    protected cancelOffTimer() {
        if (this.offTimer !== null) {
            clearTimeout(this.offTimer)
            this.offTimer = null
        }
    }

    // Called when this instance is replaced (e.g. a cloud reconnect re-emits
    // 'newDevice' for the same id — see Bridge.newDevice). Tear down our timers
    // so an orphaned instance can no longer publish to the shared MQTT topic.
    // Without this, a pending Done→Off fallback (scheduleOff) on the dropped
    // instance fired ~5 min later and clobbered the LIVE instance's stage with
    // 'Off' mid-cycle (washer stuck 'Off' through a back-to-back wash,
    // 2026-06-13 10:37). silenceTimer is otherwise only cleared on the thinq
    // 'close' event, which a drop()-by-replacement does not emit.
    override drop() {
        this.cancelOffTimer()
        clearInterval(this.silenceTimer)
        super.drop()
    }
}
