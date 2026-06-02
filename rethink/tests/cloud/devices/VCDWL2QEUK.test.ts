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
    test('standby short packet sets machine_state=Standby', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_1)
        assert.equal(ha.devices[DEVICE_ID].properties.machine_state, 'Standby')
    })

    test('second standby short packet (different seq) decodes the same', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_2)
        assert.equal(ha.devices[DEVICE_ID].properties.machine_state, 'Standby')
    })

    test('display-on-no-program decodes machine_state, course, spin, temp, cycle_phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.machine_state, 'DisplayOn')
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
        inner[10] = 0xec // ST = Selected
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
        for (const c of ['machine_state', 'cycle_phase', 'course', 'temp', 'spin', 'remaining_time']) {
            assert.ok(components[c], `component ${c} present`)
        }
        // machine_state enum includes the four known states.
        const msOptions = components.machine_state.options as string[]
        assert.ok(msOptions.includes('Standby'))
        assert.ok(msOptions.includes('Selected'))
        assert.ok(msOptions.includes('Weighing'))
        // cycle_phase enum must include SpinRamp (range-based, not in the static map).
        const cpOptions = components.cycle_phase.options as string[]
        assert.ok(cpOptions.includes('SpinRamp'))
        assert.ok(cpOptions.includes('Finished'))
        // spin uses rpm; remaining_time uses min.
        assert.equal(components.spin.unit_of_measurement, 'rpm')
        assert.equal(components.remaining_time.unit_of_measurement, 'min')
    })

    const COTTON_40_1200 = buf(
        'aaff200a00760001eb000100ec00640000000000040000000000000000a800a800000004000200090000011a040101755a0010000000041800000000000004000000050310062b00000000000000008400840000002b010000000000031a040101755a000000020004180000000000000400004f0dbb',
    )

    test('boot-up packet: locator picks status sub-block at offset 64, not device-info at 14', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COTTON_40_1200)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.machine_state, 'Selected')
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
})
