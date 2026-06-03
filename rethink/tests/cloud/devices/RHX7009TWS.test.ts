import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RHX7009TWS'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RHX7009TWS'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

const STANDBY = buf('aaff300a00130000a90001010b000100c240bb')

const DISPLAY_ON_IDLE = buf(
    'aaff300a0045008c1f000100eb0033000503000006000000004600460100000200000406000000200000010500000000000000000000000000006400040078000000630dbb',
)

const QUICK_DRY_30_SELECTED = buf(
    'aaff300a0078008d2c000100ec0066000503000006000000004600460100000200000406000000200000810500000000000000000000000000006400040078000000000003000009000000001e001e01000002000004090000002000008105000000000000000000000000000064000400780000002f5abb',
)

const DRYING_TR29 = buf(
    'aaff300a0078008d30000100ec0066000003000009000000001e001e0701000200000409000000000040810500000000000000000000000000006400040078000000000003000009000000001d001e07010002000004090000000000408105000000000000000000000000000064000400780000000ef4bb',
)

// Captured from real device: first sub-block is 65 bytes (one byte longer than
// DRYING_TR29), so the footer lands at inner[57] instead of inner[56].
// This previously caused program/remaining_time/phase to read garbage (off by 1).
const REAL_RUNNING_TR30 = buf(
    'aaff300a0078008eb3000100ec0066000003000009000000001e001e0103000200000409000000200000810500000000000000000000000000006400040078000000000003000009000000001e001e0701000200000409000000000040810500000000000000000000000000006400040078000000dad5bb',
)

const COOLDOWN = buf(
    'aaff300a0064008ded00020103002907100305070101047502090300150009050903030004000000000000000045003c0000000000010133010500255344485f58375f373030380000000000000000000102bf220b8b01070000000000000000007c7ebb',
)

const ANTI_CREASE = buf(
    'aaff300a0045008e4000010ae20033000003000009000000001e001e0701000200e3040900000000004081050000000000000000000000000000640004007800000046f9bb',
)

const FINISHED = buf(
    'aaff300a0058008e460001010400460303010105214009031e08dc000f00f0dc00000000000900000004000401f100f800000f111010000000001000f20001000000000100000000001a04f336481a20fc0cc0cd0c848bbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('device instantiates without throwing', () => {
        const { dev } = makeDevice()
        assert.ok(dev)
    })

    test('config exposes expected sensor components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID]?.config?.components
        assert.ok(cfg, 'config.components should be set on construction')
        assert.ok('run_state' in cfg, 'run_state component missing')
        assert.ok('program' in cfg, 'program component missing')
        assert.ok('phase' in cfg, 'phase component missing')
        assert.ok('remaining_time' in cfg, 'remaining_time component missing')
    })

    test('standby packet → run_state=Standby', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('display-on-idle → run_state=DisplayOn, program=Mixed Fabrics', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'DisplayOn')
        assert.equal(p.program, 'Mixed Fabrics')
    })

    test('display-on-idle → phase=Idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Idle')
    })

    test('display-on-idle → dryness_level=Extra Dry (TR=0x0046 in idle context)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.dryness_level, 'Extra Dry')
    })

    test('quick-dry-30 selected → run_state=Running, program=Quick Dry 30', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.program, 'Quick Dry 30')
    })

    test('quick-dry-30 selected → remaining_time=30', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 30)
    })

    test('drying TR=29 → remaining_time=29', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 29)
    })

    test('drying TR=29 → phase=Drying', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Drying')
    })

    test('cooldown → phase=Cooldown', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COOLDOWN)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Cooldown')
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Cooldown')
    })

    test('anti-crease → run_state=AntiCrease', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('finished → run_state=End', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FINISHED)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.program, 'Auto Dry')
    })

    test('unknown frame type byte is ignored (no crash)', () => {
        const { ha, thinq } = makeDevice()
        // Same as standby but inner[0] changed from 0x30 to 0x99
        const bad = Buffer.from(STANDBY)
        bad[2] = 0x99
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('unknown ST byte is suppressed — last known state preserved', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        // Mutate ST byte (inner[10] = buf[12]) to an unmapped value
        const unknown = Buffer.from(DISPLAY_ON_IDLE)
        unknown[12] = 0x4d
        thinq.emit('data', unknown)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'DisplayOn')
    })

    test('publishProperty deduplication — same packet twice only publishes once', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'DisplayOn')
    })

    test('real device packet with 65-byte first sub-block → program=Quick Dry 30, remaining_time=30, phase=Drying', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REAL_RUNNING_TR30)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.program, 'Quick Dry 30')
        assert.equal(p.remaining_time, 30)
        assert.equal(p.phase, 'Drying')
    })
})
