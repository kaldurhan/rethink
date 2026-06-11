import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStageState, saveStageState, storePath } from '@/cloud/devices/stage_store'

describe('stage_store', () => {
    beforeEach(() => {
        process.env.RETHINK_DATA_DIR = mkdtempSync(join(tmpdir(), 'stage-'))
    })

    test('load on missing file returns empty object', () => {
        assert.deepEqual(loadStageState(), {})
    })

    test('save then load round-trips per device', () => {
        saveStageState('dev-a', { stage: 'Washing', since: 111, lastDoneAt: null })
        saveStageState('dev-b', { stage: 'Done', since: 222, lastDoneAt: 333 })
        const s = loadStageState()
        assert.equal(s['dev-a'].stage, 'Washing')
        assert.equal(s['dev-b'].lastDoneAt, 333)
    })

    test('corrupt file returns empty object (no throw)', () => {
        writeFileSync(storePath(), '{not json')
        assert.deepEqual(loadStageState(), {})
    })
})
