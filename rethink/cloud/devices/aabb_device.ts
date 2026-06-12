// base implementation for devices with a AA...BB payload format
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { StageFSM, type TransitionTable } from './stage_fsm'
import { loadStageState, saveStageState } from './stage_store'

// Consecutive asleep-keepalives required before forcing Standby (~20 s at
// the 2 s keepalive cadence). One transient 0xe8 was observed mid-session
// (2026-06-12 11:05:18) — the streak absorbs such blips.
const KEEPALIVE_ASLEEP_STREAK = 10

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

    // Call from subclass constructor. Restores persisted stage, publishes it on
    // start(), and centralizes the Done→Off fallback timer.
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
            if (stage === 'Done') this.scheduleOff()
            else this.cancelOffTimer()
        })
    }

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data) => this.processData(data))
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
}
