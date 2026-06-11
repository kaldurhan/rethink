import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import DUT from '@/cloud/devices/VCDWL2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'VCDWL2QEUK', modelName: 'VCDWL2QEUK', swVersion: '0.0.0' }

describe('Eco 40-60 full-cycle replay (captured 2026-06-11)', () => {
    test('stage walks forward only and emits exactly one Done', (t) => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('replay-eco', META)

        // Drive Date.now from the capture timestamps so wall-clock-gated
        // logic (the 0x53 final-spin "0x76 silent >90 s" heuristic) sees the
        // same gaps the live bridge saw.
        let fakeNow = 0
        t.mock.method(Date, 'now', () => fakeNow)
        new DUT(ha.asConnection(), thinq, META)

        const stages: string[] = []
        const lines = readFileSync(join(import.meta.dirname, '../../fixtures/eco-cycle-raw.ndjson'), 'utf-8')
            .trim()
            .split('\n')
        for (const line of lines) {
            const { t: ts, rx } = JSON.parse(line)
            const [h, m, s] = (ts as string).split(':').map(Number)
            fakeNow = (h * 3600 + m * 60 + s) * 1000
            thinq.emit('data', Buffer.from(rx, 'hex'))
            const stage = ha.devices['replay-eco']?.properties.stage as string
            if (stage && stage !== stages[stages.length - 1]) stages.push(stage)
        }

        // Deterministic replay → assert the exact walk. This subsumes
        // exactly-one-Done, forward-only, and no-backstep checks. Without the
        // Date.now mock above, Spinning would be missing: replay compresses
        // time, so the >90 s 0x76-silence gate for final spin can never open.
        // (Off never appears: the capture ends before the Done→Off fallback.)
        assert.deepEqual(stages, ['Washing', 'Rinsing', 'Spinning', 'Done'])
    })
})
