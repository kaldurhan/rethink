import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/VCDWL2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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

    test('display-on-no-program: run_state suppressed, sub-block decoded', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON)
        const p = ha.devices[DEVICE_ID].properties
        // DisplayOn is filtered — run_state not published
        assert.equal(p.run_state, undefined)
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
        assert.equal(p.spin, 400)
        assert.equal(p.temp, '40')
    })

    // Synthesized minimal long packet. Inner is 36 bytes; sub-block at
    // offset 14 carries the tuple under test. The AABB envelope (aa ff …
    // 00 bb) is stripped by the base class before processAABB is called.
    function synthFrame(phA: number, phB: number, sp: number, cs: number, tt_lo: number, tt_hi: number): Buffer {
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
        inner[27] = tt_lo // sub[13] — remaining_time low byte / temp byte
        inner[28] = tt_hi // sub[14] — remaining_time high byte
        inner[33] = cs // sub[19] — CS repeat (required by locator)
        inner[34] = 0x01 // sub[20] — terminator (required by locator)
        return Buffer.concat([Buffer.from([0xaa, 0xff]), inner, Buffer.from([0x00, 0xbb])])
    }

    test('cycle_phase WashTumble + remaining_time decode when not Idle', () => {
        const { ha, thinq } = makeDevice()
        // WashTumble = 0x0b10. remaining = 0x05 + (0x00<<8) = 5 minutes.
        thinq.emit('data', synthFrame(0x0b, 0x10, 0x06, 0x2b, 0x05, 0x00))
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'WashTumble')
        assert.equal(p.remaining_time, 5)
        // temp must NOT be published when phase != Idle.
        assert.equal(p.temp, undefined)
    })

    test('cycle_phase SpinRamp range (sub[1]=0x18, sub[2] in 0x12..0x1f)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x18, 0x15, 0x06, 0x2b, 0x02, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'SpinRamp')
    })

    test('cycle_phase Finished maps from 0x100e', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0x10, 0x0e, 0x06, 0x2b, 0x00, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'Finished')
    })

    test('cycle_phase unknown for unrecognized tuple', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame(0xff, 0xff, 0x06, 0x2b, 0x00, 0x00))
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_phase, 'unknown')
    })

    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of ['run_state', 'cycle_phase', 'course', 'temp', 'spin', 'remaining_time']) {
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
        // cycle_phase enum must include SpinRamp (range-based, not in the static map).
        const cpOptions = components.cycle_phase.options as string[]
        assert.ok(cpOptions.includes('SpinRamp'))
        assert.ok(cpOptions.includes('Tumble'))
        assert.ok(cpOptions.includes('Drain'))
        assert.ok(cpOptions.includes('Finished'))
        // spin uses rpm; remaining_time uses min.
        assert.equal(components.spin.unit_of_measurement, 'rpm')
        assert.equal(components.remaining_time.unit_of_measurement, 'min')
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
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Turbowash 39')
        assert.equal(p.spin, 800)
        assert.equal(p.remaining_time, 55)
    })

    test('0x00-variant DisplayOn (Turbowash 39 selected) reads correct course, run_state suppressed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_DISPLAY_ON)
        const p = ha.devices[DEVICE_ID].properties
        // DisplayOn is filtered — run_state stays at last meaningful state
        assert.equal(p.run_state, undefined)
        assert.equal(p.course, 'Turbowash 39')
        assert.equal(p.spin, 800)
    })

    test('0x00-variant active phase (0x0010) decodes run_state=Running, phase=Tumble, remaining_time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TURBOWASH_TUMBLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.cycle_phase, 'Tumble')
        assert.equal(p.course, 'Turbowash 39')
        assert.equal(p.spin, 800)
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
        assert.equal(p.run_state, 'Running')
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
        // Broadcast-lag: appliance had not committed SP=0x0c (1200rpm) yet;
        // the status sub-block still carries SP=0x06 (400rpm).
        assert.equal(p.spin, 400)
        assert.equal(p.temp, '40')
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
            'at-20°C steady (phase unknown 0x0210, temp unpublished)',
            'aaff200a007600020a000100ec006400050110062b00000000000000007a007a0000002b010000000000031a040101755a0000000200041800000000000004000000050210062b00000000000000007a007a0000002b010000000000031a040101755a00000002000418000000000000040000f987bb',
            undefined,
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

    // Spin scroll captures. Expected values reflect the LAST sub-block.
    const SPIN_CASES: [string, string, number][] = [
        [
            'from-400 scroll',
            'aaff200a0076000214000100ec006400050810062b00000000000000007000700000002b010000000000031a040101755a0000000200041800000000000004000000050810082b00000000000000007000700000002b010000000000031a040101755a00000002000418000000000000040000546fbb',
            800,
        ],
        [
            'from-800 scroll',
            'aaff200a0076000215000100ec006400050810082b00000000000000007000700000002b010000000000031a040101755a0000000200041800000000000004000000050810092b00000000000000007300730000002b010000000000031a040101755a00000002000418000000000000040000a6bbbb',
            1000,
        ],
        [
            'from-1000 scroll',
            'aaff200a0076000217000100ec006400050810092b00000000000000007300730000002b010000000000031a040101755a00000002000418000000000000040000000508100c2b00000000000000006600660000002b010000000000031a040101755a00000002000418000000000000040000b307bb',
            1200,
        ],
        [
            'from-1200 scroll',
            'aaff200a0076000218000100ec0064000508100c2b00000000000000006600660000002b010000000000031a040101755a0000000200041800000000000004000000050810012b00000000000000006800680000002b010000000000031a040101755a000000020004180000000000000400007ef2bb',
            1400,
        ],
        [
            'from-1400 scroll',
            'aaff200a0076000219000100ec006400050810012b00000000000000006800680000002b010000000000031a040101755a0000000200041800000000000004000000050810042b00000000000000006a006a0000002b010000000000031a040101755a000000020004180000000000000400005450bb',
            0,
        ],
    ]
    for (const [label, hex, expectedSpin] of SPIN_CASES) {
        test(`spin scroll: ${label} → ${expectedSpin}rpm`, () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(hex))
            assert.equal(ha.devices[DEVICE_ID].properties.spin, expectedSpin)
        })
    }

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

    test('anti-crease packet (ST=0xe2) → run_state=AntiCrease, phase=Idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE_END)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'AntiCrease')
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
    })

    test('post-cycle Running packet (phA=0x00, phB=0x00) → cycle_phase=Finished', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_FINISHED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.cycle_phase, 'Finished')
        assert.equal(p.course, 'Blandmaterial')
    })

    test('setProperty is a no-op (sensors-only v1)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        dev.setProperty('start', '')
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 0, 'no packets emitted from HA writes')
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
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 400)
    })

    // Captured 16:56:19 — Blandmaterial with 84 min remaining, pre-wash idle phase.
    // Uses 50-byte 0x05-variant sub-blocks (terminator=0x0b, not 0x01 like temp-scroll).
    // Backwards locator finds the last sub-block (remaining=83 at sub[13]).
    const BLANDMATERIAL_PRESTART = buf(
        'aaff200a00760005cd000100ec006400050310062b000000000000000054005d00a2002b0b2600010000031c040101755a2000001001041800000000000004000000050310062b000000000000000053005d00c2002b0b2600010000031c040101755a20000010010418000000000000040000825ebb',
    )

    test('50-byte 0x05-variant (pre-wash Running) → run_state=Running, phase=Idle, remaining_time=83', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BLANDMATERIAL_PRESTART)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.cycle_phase, 'Idle')
        assert.equal(p.course, 'Blandmaterial')
        assert.equal(p.spin, 400)
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

    test('phase 0x0006 (Drain) decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', synthFrame03(0x00, 0x06, 0x01, 0x2b, 0x05, 0x00))
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cycle_phase, 'Drain')
        assert.equal(p.remaining_time, 5)
    })
})
