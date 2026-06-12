import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { storePath } from '@/cloud/devices/stage_store'
import DUT from '@/cloud/devices/VCDWL2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'VCDWL2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// Raw captures from the 2026-06-02 reverse-engineering session.
const STANDBY_1 = buf('aaff200a001300007d0001010b000100f8fdbb')
const STANDBY_2 = buf('aaff200a00130000a90001010b000100c175bb')
const DISPLAY_ON = buf(
    'aaff200a0044000081000100eb003200050310062b00000000000000008400840000002b010000000000031a040101755a00000002000418000000000000040000b098bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    // Wipe persisted stage between tests — all devices use the same DEVICE_ID
    // ('test-id') so state written in one test leaks into the next via stage-state.json.
    beforeEach(() => {
        const p = storePath()
        if (existsSync(p)) rmSync(p)
    })

    test('standby short packet sets run_state=Standby', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_1)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('second standby short packet (different seq) decodes the same', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_2)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('display-on-no-program: run_state falls back to Standby (clears stale retained message)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON)
        const p = ha.devices[DEVICE_ID].properties
        // Fresh device: cache is empty, so DisplayOn publishes Standby to flush any stale retained value.
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
        // sp=0x06 = 1000 rpm (Blandmaterial default; cloud-correlated 2026-06-12)
        assert.equal(p.spin, 1000)
        assert.equal(p.temp, '40')
    })

    // Synthesized minimal long packet. Inner is 36 bytes; sub-block at
    // offset 14 carries the tuple under test. The AABB envelope (aa ff …
    // 00 bb) is stripped by the base class before processAABB is called.
    // sub[20..21] (`act`) defaults to a drum-activity code so the frame
    // models a genuinely running machine; pass [0x01, 0x00] (the selection
    // terminator) to model panel browsing / temp scrolling instead.
    function synthFrame(
        phA: number,
        phB: number,
        sp: number,
        cs: number,
        tt_lo: number,
        tt_hi: number,
        act: [number, number] = [0x0b, 0x26],
    ): Buffer {
        const inner = Buffer.alloc(36)
        inner[0] = 0x20
        inner[10] = 0xec // ST = Running
        // Sub-block at offset 14:
        inner[14] = 0x05
        inner[15] = phA
        inner[16] = phB
        inner[17] = sp
        inner[18] = cs
        inner[19] = 0x00 // sub[5] = 0x00 (required by locator)
        inner[27] = tt_lo // sub[13] — remaining_time low byte
        inner[28] = tt_hi // sub[14] — remaining_time high byte
        inner[33] = cs // sub[19] — CS repeat (required by locator)
        inner[34] = act[0] // sub[20] — selection terminator or activity byte A
        inner[35] = act[1] // sub[21] — activity byte B
        return Buffer.concat([Buffer.from([0xaa, 0xff]), inner, Buffer.from([0x00, 0xbb])])
    }

    // Real capture 2026-06-11 11:57:33 — user browsing programmes on the
    // panel (Blandmaterial shown, Quick 14 selected). ST=0xec although the
    // drum is off; the status block ends in the selection terminator (01,00).
    const SELECTION_BROWSE = buf(
        'aaff200a00760022ee000100ec006400050310062b00000000000000008400840000002b0100000000000307040100755a0000000200041800000000000004000000030110014b00000000000000001600160000004b0100000900000307040100755a200000020004180000000000000400004eccbb',
    )

    // Captured live 2026-06-11 18:37:36 mid-Quick-14 — a 114-byte status
    // packet whose inner structure fakes a valid-looking sub-block at
    // blk@73 (cs=0x04 Allergivård, rem=2304). The true block sits at
    // blk@64 (cs=0x4b Quick 14, rem=4, act=(0e,0c)). The locator's
    // backwards scan must reject the rem=2304 candidate and recover the
    // true block.
    const MISPICK_114_QUICK14 = buf(
        'aaff200a0076002535000100ec006400000000014b00000000000000000500160026004b0e0c000900000308040100755a2000001001041800000000000004000000000000014b00000000000000000400160027004b0e0c000900000308040100755a200000100104180000000000000400002b7dbb',
    )

    test('locator rejects sub-block candidates with absurd remaining time (Guard A)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', MISPICK_114_QUICK14)
        // Mis-pick published 'Allergivård' before the guard; the recovered
        // true block (cs=0x4b, act=(0e,0c) → Spinning) flows since the
        // activity-code rework.
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Quick 14')
        assert.equal(p.cycle_phase, 'Spinning')
        assert.equal(p.remaining_time, 4)
    })

    // Captured live 2026-06-11 11:51:12 mid-Eco — same 114-byte variant,
    // but its fake block reads rem=256, which PASSES Guard A. Its course
    // byte (0x04 Allergivård) differs from the running course (0x13 Eco
    // 40-60); a mid-cycle course change is physically impossible (the
    // panel locks the dial), so the block must be discarded entirely.
    const MISPICK_114_ECO = buf(
        'aaff200a00760023fe000100ec0064000000000913000000000000000005007c004800130e0c000100000107040100755a00000010010418000000000000040000000000000913000000000000000004007c004c00130e0c000100000107040100755a000000100104180000000000000400005cdfbb',
    )

    test('mid-cycle sub-block claiming a different course is discarded (Guard B)', () => {
        const { ha, thinq } = makeDevice()
        // Establish a running Eco 40-60 cycle (stage active).
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Eco 40-60')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        thinq.emit('data', MISPICK_114_ECO)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Eco 40-60')
        // remaining_time must not pick up the bogus 256 either
        assert.notEqual(ha.devices[DEVICE_ID].properties.remaining_time, 256)
    })

    test('programme selection (ST=0xec, terminator 01,00) does NOT start the stage machine', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SELECTION_BROWSE)
        // Selection chatter is treated like DisplayOn: fresh cache → Standby,
        // never 'Running' — the drum is off.
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        // …and stage must not pretend the drum is washing.
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('trailing selection packet after standby does not flip run_state back to Running', () => {
        // Observed live 2026-06-11: power-off emits standby, then a final
        // selection packet as the panel shuts down — run_state froze at
        // 'Running' until the next interaction.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_1)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        thinq.emit('data', SELECTION_BROWSE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('selection packet mid-cycle context keeps the cached meaningful state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00)) // real running
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        thinq.emit('data', SELECTION_BROWSE) // selection-style frame must not downgrade it
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('cycle_phase Washing + remaining_time decode from activity code', () => {
        const { ha, thinq } = makeDevice()
        // synthFrame default act=[0x0b, 0x26] → Washing. Display tuple
        // (0x0b,0x10) is ignored by the new decoder.
        thinq.emit('data', synthFrame(0x0b, 0x10, 0x06, 0x2b, 0x05, 0x00))
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'Washing')
        assert.equal(p.remaining_time, 5)
        // temp must NOT be published when display phase != Idle.
        assert.equal(p.temp, undefined)
    })

    test('display tuple no longer drives cycle_phase (activity wins)', () => {
        const { ha, thinq } = makeDevice()
        // Display tuple says SpinRamp-range (0x18,0x15); activity says Washing.
        thinq.emit('data', synthFrame(0x18, 0x15, 0x06, 0x2b, 0x02, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Washing')
    })

    test('post-cycle tumble block (act 0x10) is passive: keeps run_state, publishes Finished', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x10, 0x0e, 0x06, 0x2b, 0x00, 0x00, [0x10, 0x0e]))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Finished')
        // passive block must not claim Running (fresh cache → Standby fallback)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('post-cycle idle block (act 0x00) is passive: publishes Idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x00, 0x10, 0x06, 0x2b, 0x00, 0x00, [0x00, 0x10]))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Idle')
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('unknown activity code keeps last cycle_phase and logs once', (t) => {
        const spy = captureLog(t)
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00)) // Washing
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Washing')
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x66, 0x00, [0x55, 0x0b]))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Washing')
        const logged = spy.mock.calls.map((c) => c.arguments.join(' ')).join('\n')
        assert.match(logged, /0x55/)
    })

    // Captured live 2026-06-11 (Quick 14 validated cycle): act=(0c,0b)
    // rinse block at rem=9 and act=(0e,0c) spin block at rem=5. The spin
    // block carries disp=(00,00) — the tuple the old code treated as
    // post-cycle Finished, which froze remaining_time during every final
    // spin.
    const RINSING_QUICK14 = buf(
        'aaff200a007600252b000100ec006400000010014b00000000000000000c00160023004b0c0b000900000308040100755a2000001001041800000000000004000000000010014b00000000000000000900160024004b0c0b000900000308040100755a200000100104180000000000000400006112bb',
    )
    const SPINNING_QUICK14 = buf(
        'aaff200a0076002531000100ec006400000010014b00000000000000000700160026004b0c0b000900000308040100755a2000001001041800000000000004000000000000014b00000000000000000500160026004b0e0c000900000308040100755a200000100104180000000000000400009c79bb',
    )

    test('live spin packets flow: Running, Spinning, remaining_time updates (was suppressed)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RINSING_QUICK14)
        let p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'Rinsing')
        assert.equal(p.run_state, 'Running')
        assert.equal(p.remaining_time, 9)
        thinq.emit('data', SPINNING_QUICK14)
        p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'Spinning')
        assert.equal(p.run_state, 'Running')
        assert.equal(p.remaining_time, 5)
        assert.equal(p.course, 'Quick 14')
    })

    test('unknown course byte → course publishes enum-safe "unknown", raw byte goes to log', (t) => {
        const spy = captureLog(t)
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x05, 0x10, 0x06, 0x99, 0x00, 0x00))
        // 'unknown' is in the course enum options; 'unknown_0x99' would be
        // rejected by HA and wedge the sensor.
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'unknown')
        const logged = spy.mock.calls.map((c) => c.arguments.join(' ')).join('\n')
        assert.match(logged, /0x99/)
    })

    test('unknown course byte is logged once per code, not per packet', (t) => {
        const spy = captureLog(t)
        const { thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x05, 0x10, 0x06, 0x99, 0x00, 0x00))
        thinq.emit('data', synthFrame(0x05, 0x10, 0x06, 0x99, 0x00, 0x00))
        const hits = spy.mock.calls.filter((c) => c.arguments.join(' ').includes('0x99'))
        assert.equal(hits.length, 1)
    })

    // ── Pause (captured 2026-06-11, correlated with cloud state PAUSE) ──────
    // Info-class packets (inner[8]=0x02, ST=0x03) carry a sub-state code at
    // inner[13], mirrored at inner[17]: 0x11 idle-browse, 0x1e pre-detect,
    // 0x01 DETECTING, 0x0b DETERGENT_INPUT, 0x0c PAUSE. Only 0x0c is a pause;
    // the others occur during a normal running cycle and must stay suppressed.

    // 11:58:20 — cloud reported state PAUSE 11:58:16→11:58:28
    const PAUSE_INFO = buf(
        'aaff200a00880022ff00020103004d0c0e01020c00e1008c0b0000008603c602040204000004020401010a0000400000040000010200752d5a00072a47001b630063010200030003000000000000000000000000000000000000001601050025564344574c325145554b000000000000000000000102c1220b8b0107000000000000000000dcf2bb',
    )
    // 11:57:54 — cloud state DETECTING (cycle starting, NOT paused)
    const DETECTING_INFO = buf(
        'aaff200a00880022f600020103004d010e01020100e1008a030000008603c603280328000004020401020a0000400000040000010200752d5a00072a47001b630063010000000000000000000000000000000000000000000000001601050025564344574c325145554b000000000000000000000102bc220b8b0107000000000000000000fbd9bb',
    )
    // 11:58:09 — cloud state DETERGENT_INPUT (cycle running, NOT paused)
    const DETERGENT_INFO = buf(
        'aaff200a00470022fb00020103000c0b0e01020b00e1008b02000001050025564344574c325145554b000000000000000000000102bf220b8b0107000000000000000000c3a9bb',
    )

    test('pause info packet (sub-state 0x0c) → run_state=Paused, stage=Paused', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PAUSE_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Paused')
    })

    test('detecting/detergent info packets are NOT a pause — stay suppressed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DETECTING_INFO)
        thinq.emit('data', DETERGENT_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('resume after pause restores run_state=Running and the pre-pause stage', () => {
        const { ha, thinq } = makeDevice()
        // Tumble phase with no spin ramps yet → stage=Washing
        thinq.emit('data', synthFrame(0x00, 0x10, 0x06, 0x2b, 0x05, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        thinq.emit('data', PAUSE_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Paused')
        thinq.emit('data', synthFrame(0x00, 0x10, 0x06, 0x2b, 0x04, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
    })

    test('running packet sets stage=Washing even when phase decodes as Idle (Eco 40-60 0x__0e tuples)', () => {
        // Live bug 2026-06-11: Eco 40-60 emits 0x030e-family tuples while
        // running (mapped to Idle), so keying Washing on phase==='Tumble'
        // left stage stuck on Off for the whole cycle.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
    })

    test('running packet with unknown phase tuple still sets stage=Washing before first spin ramp', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x0b, 0x02, 0x09, 0x13, 0x67, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
    })

    test('run_state and stage enum options include Paused', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        assert.ok((cfg.run_state.options as string[]).includes('Paused'))
        assert.ok((cfg.stage.options as string[]).includes('Paused'))
    })

    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'run_state',
            'cycle_phase',
            'course',
            'temp',
            'spin',
            'remaining_time',
            'water_temp',
            'elapsed_time',
            'phase_remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // run_state enum includes the published states (DisplayOn is filtered).
        const msOptions = components.run_state.options as string[]
        assert.ok(msOptions.includes('Standby'))
        assert.ok(msOptions.includes('Running'))
        assert.ok(msOptions.includes('End'))
        assert.ok(msOptions.includes('AntiCrease'))
        assert.ok(!msOptions.includes('DisplayOn'), 'DisplayOn must not appear in options')
        assert.ok(!msOptions.includes('Weighing'), 'Weighing must not appear — 0x04 is End')
        // cycle_phase enum: the coarse activity-code vocabulary (2026-06-11 spec).
        const cpOptions = components.cycle_phase.options as string[]
        assert.deepEqual(cpOptions, [
            'Idle',
            'Detecting',
            'Filling',
            'Washing',
            'Rinsing',
            'Spinning',
            'Finished',
            'unknown',
        ])
        // spin uses rpm; time sensors use min; water_temp uses °C.
        assert.equal(components.spin.unit_of_measurement, 'rpm')
        assert.equal(components.remaining_time.unit_of_measurement, 'min')
        assert.equal(components.elapsed_time.unit_of_measurement, 'min')
        assert.equal(components.phase_remaining_time.unit_of_measurement, 'min')
        assert.equal(components.water_temp.unit_of_measurement, '°C')
    })

    // Real captured packet from active Turbowash 39 cycle (1 minute in).
    // Uses 0x03-variant sub-block; findStatusSubBlock previously returned -1 for these.
    const TURBOWASH_RUNNING_1MIN = buf(
        'aaff200a00760003c4000100ec006400030310087a000000000000000038003f0080007a0b2600090000031b040101755a2000001001041800000000000004000000030310087a000000000000000037003f009c007a0b2600090000031b040101755a200000100104180000000000000400007fd8bb',
    )

    // DisplayOn with Turbowash 39 selected: uses 0x00-variant sub-block.
    // Previously findStatusSubBlock returned -1 → course was never updated from a
    // prior Blandmaterial session.
    const TURBOWASH_DISPLAY_ON = buf(
        'aaff200a004400045d000100eb003200000010087a00000000000000001d003f0100007a0c0b00090000031b040101755a20000010010418000000000000040000bbeebb',
    )

    // Tumble phase of Turbowash 39: uses 0x00-variant sub-block, phase 0x0010.
    // remaining_time counts down from ~29 minutes.
    const TURBOWASH_TUMBLE = buf(
        'aaff200a007600046a000100ec006400000010087a00000000000000001d003f0100007a0c0b00090000031b040101755a2000001001041800000000000004000000000010087a00000000000000001c003f0103007a0c0b00090000031b040101755a20000010010418000000000000040000567abb',
    )

    const COTTON_40_1200 = buf(
        'aaff200a00760001eb000100ec00640000000000040000000000000000a800a800000004000200090000011a040101755a0010000000041800000000000004000000050310062b00000000000000008400840000002b010000000000031a040101755a000000020004180000000000000400004f0dbb',
    )

    test('0x03-variant sub-block (active Turbowash cycle) decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        // act=(0b,26) → Washing. The old display decode said 'Idle' 1 min
        // into an active cycle — wrong.
        assert.equal(p.cycle_phase, 'Washing')
        assert.equal(p.course, 'Turbowash 39')
        // sp=0x08 = 1200 rpm (Turbowash 39 default; cloud-correlated 2026-06-12)
        assert.equal(p.spin, 1200)
        assert.equal(p.remaining_time, 55)
    })

    test('0x00-variant DisplayOn (Turbowash 39 selected) reads correct course; run_state falls back to Standby on fresh device', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_DISPLAY_ON)
        const p = ha.devices[DEVICE_ID].properties
        // Fresh device: cache is empty, so DisplayOn publishes Standby to flush any stale retained value.
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.course, 'Turbowash 39')
        assert.equal(p.spin, 1200)
    })

    test('0x00-variant DisplayOn during active run → run_state stays Running (cache-check guards mid-cycle)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        thinq.emit('data', TURBOWASH_DISPLAY_ON)
        // Cache has 'Running' → DisplayOn must not overwrite it.
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('0x00-variant active block decodes run_state=Running, phase from act=(0c,..)=Rinsing, remaining_time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_TUMBLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.cycle_phase, 'Rinsing')
        assert.equal(p.course, 'Turbowash 39')
        assert.equal(p.spin, 1200)
        assert.equal(p.remaining_time, 28)
    })

    test('unknown ST byte (0x4d telemetry burst) is suppressed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        // 0x4d = telemetry burst, not a mapped state
        const telemetry = buf(
            'aaff200a00300003a50001014d001e0302000d022b027a024f0255024b025e022e027202130216021d02880204fb5bbb',
        )
        thinq.emit('data', telemetry)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('boot-up packet: locator picks status sub-block at offset 64, not device-info at 14', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COTTON_40_1200)
        const p = ha.devices[DEVICE_ID].properties
        // Boot-up frame is selection-context (drum off, terminator 01,00):
        // since the selection fix, run_state falls back to Standby, not Running.
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
        // Broadcast-lag: appliance had not committed the 1200 rpm selection
        // (SP=0x08) yet; the status sub-block still carries SP=0x06 (1000 rpm).
        assert.equal(p.spin, 1000)
        assert.equal(p.temp, '40')
    })

    test('post-cycle tumble (act 0x10) is passive — End state preserved', () => {
        const { ha, thinq } = makeDevice()
        // Put device into End state first
        const endFrame = synthFrame(0x10, 0x0e, 0x06, 0x2b, 0x00, 0x00, [0x10, 0x0e])
        endFrame[12] = 0x04 // inner[10] = ST=End
        thinq.emit('data', endFrame)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        // Post-cycle tumble: ST=Running, act 0x10 (anti-wrinkle tumble)
        const tumbleFrame = synthFrame(0x00, 0x00, 0x06, 0x2b, 0x00, 0x00, [0x10, 0x0e])
        thinq.emit('data', tumbleFrame)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
    })

    // Temperature scroll captures. Expected values reflect the LAST sub-block
    // (the parser's locator picks the highest-offset sub-block).
    // During scroll transitions, the phase may be non-Idle, so temp is not
    // published; in steady-state Idle phases, temp IS published.
    const TEMP_CASES: [string, string, string | undefined][] = [
        [
            'from-cold scroll (phase WashFill, temp unpublished)',
            'aaff200a0076000209000100ec006400050810062b00000000000000007000700000002b010000000000031a040101755a0000000200041800000000000004000000050110062b00000000000000007a007a0000002b010000000000031a040101755a000000020004180000000000000400000e8fbb',
            undefined,
        ],
        [
            'at-30°C steady (phase Idle 0x0210, temp 30)',
            'aaff200a007600020a000100ec006400050110062b00000000000000007a007a0000002b010000000000031a040101755a0000000200041800000000000004000000050210062b00000000000000007a007a0000002b010000000000031a040101755a00000002000418000000000000040000f987bb',
            '30',
        ],
        [
            'to-40°C scroll (phase Idle, temp 40)',
            'aaff200a007600020c000100ec006400050210062b00000000000000007a007a0000002b010000000000031a040101755a0000000200041800000000000004000000050310062b00000000000000008400840000002b010000000000031a040101755a00000002000418000000000000040000ade4bb',
            '40',
        ],
        [
            'to-60°C scroll (phase Idle, temp 60)',
            'aaff200a007600020d000100ec006400050310062b00000000000000008400840000002b010000000000031a040101755a0000000200041800000000000004000000050510062b00000000000000009800980000002b010000000000031a040101755a0000000200041800000000000004000043c5bb',
            '60',
        ],
    ]
    for (const [label, hex, expectedTemp] of TEMP_CASES) {
        test(`temperature scroll: ${label}`, () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(hex))
            assert.equal(ha.devices[DEVICE_ID].properties.temp, expectedTemp)
        })
    }

    // TEMP_95: phA=0x06, phB=0x10 → phase 0x0610='Idle' (confirmed from Cotton temp-scroll
    // capture 2026-06-11, where cloud TEMP_95 correlated with phA=0x06 in 0x03-variant sub-blocks).
    test('temperature scroll: TEMP_95 settled (phA=0x06, phase Idle 0x0610)', () => {
        const { ha, thinq } = makeDevice()
        // temp scrolls are selection-state frames → selection terminator
        thinq.emit('data', synthFrame(0x06, 0x10, 0x09, 0x2e, 0x8a, 0x00, [0x01, 0x00]))
        assert.equal(ha.devices[DEVICE_ID].properties.temp, '95')
    })

    // Spin scroll captures. Expected values reflect the LAST sub-block.
    // Expected rpm per the cloud-correlated 2026-06-12 map: the scanner picks
    // the LAST sub-block, so each case asserts that block's sp byte.
    // Wheel order (byte): 01→04→06→08→09→0c = 400→800→1000→1200→1400→drain.
    const SPIN_CASES: [string, string, number][] = [
        [
            'scroll lands on sp=0x08',
            'aaff200a0076000214000100ec006400050810062b00000000000000007000700000002b010000000000031a040101755a0000000200041800000000000004000000050810082b00000000000000007000700000002b010000000000031a040101755a00000002000418000000000000040000546fbb',
            1200,
        ],
        [
            'scroll lands on sp=0x09',
            'aaff200a0076000215000100ec006400050810082b00000000000000007000700000002b010000000000031a040101755a0000000200041800000000000004000000050810092b00000000000000007300730000002b010000000000031a040101755a00000002000418000000000000040000a6bbbb',
            1400,
        ],
        [
            'scroll lands on sp=0x0c (drain only)',
            'aaff200a0076000217000100ec006400050810092b00000000000000007300730000002b010000000000031a040101755a00000002000418000000000000040000000508100c2b00000000000000006600660000002b010000000000031a040101755a00000002000418000000000000040000b307bb',
            0,
        ],
        [
            'scroll lands on sp=0x01',
            'aaff200a0076000218000100ec0064000508100c2b00000000000000006600660000002b010000000000031a040101755a0000000200041800000000000004000000050810012b00000000000000006800680000002b010000000000031a040101755a000000020004180000000000000400007ef2bb',
            400,
        ],
        [
            'scroll lands on sp=0x04',
            'aaff200a0076000219000100ec006400050810012b00000000000000006800680000002b010000000000031a040101755a0000000200041800000000000004000000050810042b00000000000000006a006a0000002b010000000000031a040101755a000000020004180000000000000400005450bb',
            800,
        ],
    ]
    for (const [label, hex, expectedSpin] of SPIN_CASES) {
        test(`spin scroll: ${label} → ${expectedSpin}rpm`, () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(hex))
            assert.equal(ha.devices[DEVICE_ID].properties.spin, expectedSpin)
        })
    }

    test('inter-rinse spin activity (0x27) publishes cycle_phase=Rinsing (panel parity)', () => {
        const { ha, thinq } = makeDevice()
        // Live 2026-06-12 12:57: act walked 0c → 27 → 0c between rinse spans
        // while the panel showed "Sköljning" throughout.
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x13, 0x00, [0x27, 0x0c]))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Rinsing')
    })

    test('frame not matching AA..BB envelope is ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID]?.properties.run_state, undefined)
    })

    test('frame with inner[0] != 0x20 is ignored', () => {
        const { ha, thinq } = makeDevice()
        // Valid AA..BB envelope; inner first byte is 0x99 (not 0x20).
        thinq.emit('data', buf('aa09990a0102030400bb'))
        assert.equal(ha.devices[DEVICE_ID]?.properties.run_state, undefined)
    })

    test('publishCache suppresses redundant publishes (idempotency)', () => {
        const { ha, thinq } = makeDevice()
        let publishes = 0
        const original = ha.publishProperty.bind(ha)
        ha.publishProperty = (id: string, prop: string, value: string | number) => {
            publishes++
            return original(id, prop, value)
        }
        thinq.emit('data', STANDBY_1)
        const after1 = publishes
        thinq.emit('data', STANDBY_1)
        // The second emit should not republish run_state (cache hit).
        assert.equal(publishes, after1, 'no second publish for identical packet')
    })

    // End-of-cycle captures (18:07 window, Blandmaterial full run).
    // 18:07:33 — ST=0x04 (End); no valid sub-block in this packet type.
    const END_OF_CYCLE = buf(
        'aaff200a00580007040001010400460303010100040506073900000000ff012d00fd000001171300011e11000101fd787400fd00fd00fdfdfd000000da1d0300000100074302000464004080123cdc49431a001a003a38bb',
    )
    // 18:07:39 — ST=0xe2 (AntiCrease); brief post-End drum state.
    const ANTI_CREASE_END = buf(
        'aaff200a004400070500010ae2003200050310062b00000000000000006b006b0146002b030100000000031c040101755a2000000000041800000000000004000083febb',
    )
    // 18:07:47 — ST=0xec (Running); post-cycle double-sub-block where phA=0x00,
    // phB=0x00 encodes Finished. findStatusSubBlock picks the last sub-block.
    const RUNNING_FINISHED = buf(
        'aaff200a0076000707000100ec006400000000062b000000000000000001005d0145002b0e0c00010000031c040101755a2000001001041800000000000004000000000000062b000000000000000001005d0146002b100e00010000031c040101755a20000010010418000000000000040000d822bb',
    )

    test('end-of-cycle packet (ST=0x04) → run_state=End, no sub-block update', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', END_OF_CYCLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'End')
        // No valid sub-block → phase/spin/course/remaining not touched
        assert.equal(p.cycle_phase, undefined)
    })

    test('anti-crease packet (ST=0xe2) → run_state=AntiCrease, phase=Finished', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE_END)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'AntiCrease')
        assert.equal(p.cycle_phase, 'Finished')
        assert.equal(p.course, 'Blandmaterial')
    })

    test('post-cycle Running packet (act 0x10) is passive — End preserved, phase=Finished', () => {
        const { ha, thinq } = makeDevice()
        // Establish End state first, then send the post-cycle tumble packet
        thinq.emit('data', END_OF_CYCLE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        thinq.emit('data', RUNNING_FINISHED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'End')
        assert.equal(p.cycle_phase, 'Finished')
        // The tumble block carries rem=1 — it must not blip remaining_time
        // off the End-reset 0 (live 2026-06-12 07:22:21, 0 → 1).
        assert.equal(p.remaining_time, 0)
    })

    // Running packet where last sub-block has phase=0x100e (Finished), confirmed from
    // end-of-cycle capture at 15:38:22. Differs from RUNNING_FINISHED (0x0000) —
    // appears at the rinse-drain→end transition rather than during anti-crease tumble.
    const RUNNING_FINISHED_100E = buf(
        'aaff200a0076000707000100ec006400000000062b000000000000000001005d0145002b0e0c00010000031c040101755a200000100104180000000000000400000000100e062b000000000000000001005d0146002b100e00010000031c040101755a20000010010418000000000000040000d822bb',
    )

    test('post-cycle Running packet (disp 0x100e, act 0x10) is passive — End preserved, phase=Finished', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', END_OF_CYCLE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        thinq.emit('data', RUNNING_FINISHED_100E)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'End')
        assert.equal(p.cycle_phase, 'Finished')
    })

    test('End state publishes remaining_time=0 (so done-timeout fires after 30 min)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 55, 'pre-condition: remaining non-zero')
        thinq.emit('data', END_OF_CYCLE)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('AntiCrease state publishes remaining_time=0', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 55, 'pre-condition: remaining non-zero')
        thinq.emit('data', ANTI_CREASE_END)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    // 0x8a periodic snapshot: inner[23]=elapsed_time, inner[25]=phase_remaining_time,
    // inner[31]=water_temp. ST=0x02 is not in STATES_VCDWL — packet must be handled
    // via type-check before the state table, same as door packets.
    //
    // Frame breakdown (40 bytes total):
    //   aa ff — AABB header (byte2=ff → long packet)
    //   inner[0..35] — 36 bytes processed by processAABB:
    //     [0]=20 [3]=8a [10]=02(ST) [23]=28(elapsed=40) [25]=0e(remain=14) [31]=2d(temp=45°C)
    //   00 bb — dummy checksum + framing
    const PERIODIC_8A = buf('aaff200a008a00151c00020102004f0e0102000000008d0b0028010e00000000012d2d2d2d2d00bb')

    test('0x8a periodic snapshot publishes elapsed_time, phase_remaining_time, water_temp', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PERIODIC_8A)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.elapsed_time, 0x28, 'elapsed_time = 40 min')
        assert.equal(p.phase_remaining_time, 0x0e, 'phase_remaining_time = 14 min')
        assert.equal(p.water_temp, 0x2d, 'water_temp = 45°C')
    })

    test('0x8a does not affect run_state or cycle_phase (intercepted before state check)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        thinq.emit('data', PERIODIC_8A)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Washing')
    })

    // Real captured 0x53 motor-ramp packet from 13:39:01 (rinse-tumble start).
    // inner[12]=0x18 (motor active), inner[13]=0x12 (speed step). ST=0x03 (not in
    // STATES_VCDWL) — must be intercepted before state check, same as 0x8a.
    const MOTOR_RAMP_53 = buf(
        'aaff200a0053001a83000201030018120e01021200dd00f50c00360000000000000000000000000001050025564344574c325145554b0000000000000000000000000102c0220b8b010700000000000000000000c500bb',
    )

    test('0x53 motor ramp is inert — stage now comes from activity codes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', MOTOR_RAMP_53)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, undefined)
        assert.equal(p.stage, undefined)
        assert.equal(p.run_state, undefined)
    })

    test('0x53 mid-cycle does not disturb stage or sensors', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        const runState = ha.devices[DEVICE_ID].properties.run_state
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        thinq.emit('data', MOTOR_RAMP_53)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, runState)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        assert.equal(ha.devices[DEVICE_ID].properties.elapsed_time, undefined)
    })

    test('activity codes drive stage: 0b→Washing, 0c→Rinsing, 0e→Spinning (no 0x53 needed)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x50, 0x00, [0x0b, 0x26]))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x30, 0x00, [0x0c, 0x0b]))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Rinsing')
        // Inter-rinse drain+spin (0x27) keeps stage at Rinsing.
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x13, 0x00, [0x27, 0x0c]))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Rinsing')
        thinq.emit('data', synthFrame(0x00, 0x00, 0x08, 0x2b, 0x09, 0x00, [0x0e, 0x0c]))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Spinning')
    })

    test('initial_time captured on the first active frame only (cycle-start edge)', () => {
        const { ha, thinq } = makeDevice()
        // Selection frame (passive act 0x01) must not set initial_time.
        thinq.emit('data', synthFrame(0x03, 0x10, 0x08, 0x2b, 0x6b, 0x00, [0x01, 0x00]))
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, undefined)
        // First active frame: remaining 107 = programme duration.
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x6b, 0x00, [0x0b, 0x01]))
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 107)
        // Later frames count down without touching initial_time.
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x64, 0x00, [0x0b, 0x26]))
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 100)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 107)
    })

    test('End packets never decode a sub-block even if one looks valid (spec §6.4)', () => {
        const { ha, thinq } = makeDevice()
        // Synthetic End frame carrying a plausible sub-block with a different course.
        const endWithSub = synthFrame(0x00, 0x10, 0x08, 0x4b, 0x10, 0x00, [0x0b, 0x26])
        endWithSub[12] = 0x04 // inner[10] = ST=End
        thinq.emit('data', endWithSub)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'End')
        assert.equal(p.remaining_time, 0)
        // Course/phase from the embedded block must NOT publish.
        assert.equal(p.course, undefined)
        assert.equal(p.cycle_phase, undefined)
    })

    // Real door events captured live 2026-06-12 10:20 (idle door test, seven
    // alternating open/close events, cloud-correlated via the doorLock
    // follow-up). 65-byte info-class frames: inner[12]=0x06, event code
    // inner[13]=0x10, door state at inner[18] (0x01=open, 0x02=closed).
    const DOOR_OPEN_INFO = buf(
        'aaff200a0041002798000201030006100e0102100101050025564344574c325145554b000000000000000000000102c2220b8b010700000000000000000065c3bb',
    )
    const DOOR_CLOSE_INFO = buf(
        'aaff200a0041002799000201030006100e0102100201050025564344574c325145554b000000000000000000000102c2220b8b0107000000000000000000a2f0bb',
    )
    // 99-byte info-class telemetry ([12]=0x28, [13]=0x1e) captured 10:21:51
    // while the user scrolled the spin wheel, door untouched. The old decoder
    // keyed door on inner[3]=0x63 — which is the frame-LENGTH byte (0x63=99) —
    // and published a false "open" for every such frame.
    const INFO_99_TELEMETRY = buf(
        'aaff200a00630027a40002010300281e0e01021e00e400430100000a0008002100210021002100210021002103dc00022a47001b63006301050025564344574c325145554b000000000000000000000102c3220b8b0107000000000000000000f9acbb',
    )

    test('door event frame ([12]=0x06, [13]=0x10, [18]=0x01) publishes door=open', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_OPEN_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'open')
    })

    test('door event frame ([18]=0x02) publishes door=closed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_OPEN_INFO)
        thinq.emit('data', DOOR_CLOSE_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'closed')
    })

    test('99-byte info telemetry does NOT publish door (regression: false open through entire cycles)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INFO_99_TELEMETRY)
        assert.equal(ha.devices[DEVICE_ID].properties.door, undefined)
    })

    // Wake event captured live 2026-06-12 11:04:41 — opening the SLEEPING
    // washer's door wakes it and emits [13]=0x11 with cause [18]=0x04
    // (woken-by-door-open) instead of a [13]=0x10 door event.
    const DOOR_WAKE_INFO = buf(
        'aaff200a00410027cf000201030006110e0102110401050025564344574c325145554b000000000000000000000102c1220b8b01070000000000000000003338bb',
    )

    test('wake event ([13]=0x11, cause 0x04) publishes door=open (first open from sleep)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_WAKE_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'open')
    })

    test('door event does not affect run_state or the stage machine', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        thinq.emit('data', DOOR_OPEN_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
    })

    // Real captured keepalives: e8 = asleep, e9 = session active.
    const KEEPALIVE_ASLEEP = buf('aa0720e80a96bb')
    const KEEPALIVE_SESSION = buf('aa0720e90a91bb')

    test('10 consecutive asleep keepalives correct a stale AntiCrease to Standby + stage Off', () => {
        const { ha, thinq } = makeDevice()
        // Latch a post-cycle state, as left behind by a missed Standby frame.
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        thinq.emit('data', ANTI_CREASE_END)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Done')
        for (let i = 0; i < 10; i++) thinq.emit('data', KEEPALIVE_ASLEEP)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Off')
    })

    test('9 asleep keepalives are not enough (hysteresis); a session keepalive resets the streak', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        thinq.emit('data', ANTI_CREASE_END)
        for (let i = 0; i < 9; i++) thinq.emit('data', KEEPALIVE_ASLEEP)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
        // e9 blip resets — 9 more e8 still must not fire
        thinq.emit('data', KEEPALIVE_SESSION)
        for (let i = 0; i < 9; i++) thinq.emit('data', KEEPALIVE_ASLEEP)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
        thinq.emit('data', KEEPALIVE_ASLEEP)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('asleep keepalives on a fresh device publish Standby (corrects stale retained values after restart)', () => {
        const { ha, thinq } = makeDevice()
        for (let i = 0; i < 10; i++) thinq.emit('data', KEEPALIVE_ASLEEP)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('session keepalives alone publish nothing', () => {
        const { ha, thinq } = makeDevice()
        for (let i = 0; i < 20; i++) thinq.emit('data', KEEPALIVE_SESSION)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('frame silence >150 s marks the device unavailable; next frame restores it', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', KEEPALIVE_SESSION)
        // discovery published availability=online at construction
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
        dev.checkSilence(Date.now() + 200_000)
        assert.equal(ha.devices[DEVICE_ID].availability, 'offline')
        // any frame flips it back
        thinq.emit('data', KEEPALIVE_SESSION)
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
    })

    test('checkSilence within the window does nothing', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', KEEPALIVE_SESSION)
        dev.checkSilence(Date.now() + 60_000)
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
    })

    test('Done publishes last_cycle_duration and last_cycle_energy', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_RUNNING_1MIN) // starts cycle; carries 10 08 energy block
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        const energy =
            ha.devices[DEVICE_ID].properties.cycle_energy ?? ha.devices[DEVICE_ID].properties.course_spend_power
        thinq.emit('data', END_OF_CYCLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.stage, 'Done')
        assert.equal(p.last_cycle_duration, 0, 'same-tick cycle rounds to 0 min')
        assert.equal(p.last_cycle_energy, p.course_spend_power)
        assert.ok(energy !== undefined || p.course_spend_power !== undefined)
    })

    test('unknown activity code publishes last_unknown diagnostic', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x00, 0x10, 0x08, 0x2b, 0x50, 0x00, [0x31, 0x0b]))
        assert.equal(ha.devices[DEVICE_ID].properties.last_unknown, 'activity 0x31')
    })

    test('0x8a publishes the diagnostic water-temp series [32..35]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PERIODIC_8A)
        const p = ha.devices[DEVICE_ID].properties
        // fixture carries 2d at [31..35] → 45 °C across the series
        assert.equal(p.water_temp_2, 0x2d)
        assert.equal(p.water_temp_5, 0x2d)
    })

    test('active Running block infers door=closed (close-from-sleep emits no event)', () => {
        const { ha, thinq } = makeDevice()
        // Door left 'open' from a sleep-time test, then the user silently
        // closes it and starts a cycle — the running block must correct it.
        thinq.emit('data', DOOR_OPEN_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'open')
        thinq.emit('data', TURBOWASH_RUNNING_1MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'closed')
    })

    test('setProperty is a no-op (sensors-only v1)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        dev.setProperty('start', '')
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 0, 'no packets emitted from HA writes')
    })

    // Captured live 2026-06-11 19:40 during the full programme-knob scroll,
    // cloud-correlated in real time: 0x37 = RINSE_SPIN (Sköljning +
    // Centrifugering), 0x4e = SPIN_ONLY (Centrifugering). Selection packets;
    // current course is in the trailing sub-block.
    const SELECTION_RINSE_SPIN = buf(
        'aaff200a0076002584000100ec00640003050e09040000000000000000a800a8000000040100000000000109040100755a001000020004180000000000000400000000000e09370000000000000000130013000000370100000900000109040100755a0000000200041800000000000004000083e4bb',
    )
    const SELECTION_SPIN_ONLY = buf(
        'aaff200a0076002585000100ec00640000000e09370000000000000000130013000000370100000900000109040100755a0000000200041800000000000004000000000000094e00000000000000000e000e0000004e0100000900000009040100755a00000002000418000000000000040000300bbb',
    )

    test('knob-scroll selection decodes Sköljning + Centrifugering (0x37) and Centrifugering (0x4e)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SELECTION_RINSE_SPIN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Sköljning + Centrifugering')
        thinq.emit('data', SELECTION_SPIN_ONLY)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Centrifugering')
        // selection only — the stage machine must stay off
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('standby packet after display-on does not clobber prior course/spin/temp', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.temp, '40')
        thinq.emit('data', STANDBY_1)
        // run_state updated, but other props retain their last-known value.
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.temp, '40')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Blandmaterial')
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 1000)
    })

    // Captured 16:56:19 — Blandmaterial with 84 min remaining, pre-wash idle phase.
    // Uses 50-byte 0x05-variant sub-blocks (terminator=0x0b, not 0x01 like temp-scroll).
    // Backwards locator finds the last sub-block (remaining=83 at sub[13]).
    const BLANDMATERIAL_PRESTART = buf(
        'aaff200a00760005cd000100ec006400050310062b000000000000000054005d00a2002b0b2600010000031c040101755a2000001001041800000000000004000000050310062b000000000000000053005d00c2002b0b2600010000031c040101755a20000010010418000000000000040000825ebb',
    )

    test('50-byte 0x05-variant (pre-wash Running) → run_state=Running, phase=Washing, remaining_time=83', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BLANDMATERIAL_PRESTART)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        // act=(0b,26) → Washing (the old display decode said 'Idle' while
        // the drum was already filling/tumbling)
        assert.equal(p.cycle_phase, 'Washing')
        assert.equal(p.course, 'Blandmaterial')
        assert.equal(p.spin, 1000)
        assert.equal(p.remaining_time, 83)
        // temp must NOT be published when sub[20]=0x0b (active-running sub-block)
        assert.equal(p.temp, undefined)
    })

    // Synthetic frame for the Drain phase (0x0006). Uses a 0x03-variant sub-block
    // with phA=0x00, phB=0x06, observed in Blandmaterial end-of-cycle packets.
    function synthFrame03(phA: number, phB: number, sp: number, cs: number, tt_lo: number, tt_hi: number): Buffer {
        const inner = Buffer.alloc(36)
        inner[0] = 0x20
        inner[10] = 0xec
        inner[14] = 0x03
        inner[15] = phA
        inner[16] = phB
        inner[17] = sp
        inner[18] = cs
        inner[19] = 0x00
        inner[27] = tt_lo
        inner[28] = tt_hi
        inner[33] = cs // cs-repeat at +19
        inner[34] = 0x0b
        return Buffer.concat([Buffer.from([0xaa, 0xff]), inner, Buffer.from([0x00, 0xbb])])
    }

    test('0x03-variant block with old Drain display tuple (0x0006) decodes activity Washing', () => {
        // The display tuple 0x0006 was once mapped to 'Drain'; activity codes
        // are authoritative now (synthFrame03 hardcodes act 0x0b).
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame03(0x00, 0x06, 0x01, 0x2b, 0x05, 0x00))
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'Washing')
        assert.equal(p.remaining_time, 5)
    })

    test('cancelled cycle (standby mid-wash) → stage Off, never Done', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Washing')
        thinq.emit('data', STANDBY_1)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Off')
    })

    test('persisted active stage survives a device restart and still yields one Done', () => {
        // Simulates: add-on goes down mid-wash, cycle ends, add-on returns and
        // sees the AntiCrease packet. RETHINK_DATA_DIR is shared within the run.
        const first = makeDevice()
        first.thinq.emit('data', synthFrame(0x03, 0x0e, 0x09, 0x13, 0x67, 0x00))
        assert.equal(first.ha.devices[DEVICE_ID].properties.stage, 'Washing')

        const second = makeDevice() // fresh instance, same device id
        second.dev.start()
        assert.equal(second.ha.devices[DEVICE_ID].properties.stage, 'Washing') // restored, not Off
        second.thinq.emit('data', ANTI_CREASE_END)
        assert.equal(second.ha.devices[DEVICE_ID].properties.stage, 'Done')
    })

    test('retained End replay while Off does not produce Done', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.start()
        thinq.emit('data', STANDBY_1) // ensure Off persisted for this id
        thinq.emit('data', END_OF_CYCLE) // stray End packet while Off
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Off')
    })
})
