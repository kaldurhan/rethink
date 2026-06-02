import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RHX7009TWS'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RHX7009TWS'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

// TODO: add verbatim hex captures below once packet capture session is complete.
// Use buf() from '@/tests/helpers/mocks' to convert hex strings to Buffers.
//
// Captures needed:
//   - standby / power-off packet
//   - idle / ready packet (cycle selected, not running)
//   - running packet (e.g. Cotton in progress, 30 min remaining)
//   - end-of-cycle packet
//   - at least one packet per dry-level setting

describe(MODEL_ID, () => {
    test('placeholder — device instantiates without throwing', () => {
        const { dev } = makeDevice()
        assert.ok(dev)
    })
})
