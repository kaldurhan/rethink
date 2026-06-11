import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import DUT from '@/cloud/devices/VCDWL2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'VCDWL2QEUK', modelName: 'VCDWL2QEUK', swVersion: '0.0.0' }

describe('Eco 40-60 full-cycle replay (captured 2026-06-11)', () => {
    test('stage walks forward only and emits exactly one Done', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('replay-eco', META)
        new DUT(ha.asConnection(), thinq, META)

        const stages: string[] = []
        const lines = readFileSync(join(import.meta.dirname, '../../fixtures/eco-cycle-raw.ndjson'), 'utf-8')
            .trim()
            .split('\n')
        for (const line of lines) {
            const { rx } = JSON.parse(line)
            thinq.emit('data', Buffer.from(rx, 'hex'))
            const s = ha.devices['replay-eco']?.properties.stage as string
            if (s && s !== stages[stages.length - 1]) stages.push(s)
        }

        assert.equal(stages.filter((s) => s === 'Done').length, 1, `stage sequence: ${stages.join('→')}`)
        const doneIdx = stages.indexOf('Done')
        assert.ok(doneIdx === stages.length - 1 || stages[doneIdx + 1] === 'Off')
        assert.ok(stages.includes('Washing'))
    })
})
