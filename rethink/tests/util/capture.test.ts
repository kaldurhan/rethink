import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initCapture, captureDevice, captureCloud, sweepOldCaptures, RETENTION_DAYS } from '@/util/capture'

describe('capture', () => {
    let dir: string

    afterEach(() => {
        initCapture(null)
        if (dir) rmSync(dir, { recursive: true, force: true })
    })

    test('captureDevice and captureCloud append daily ndjson files', () => {
        dir = mkdtempSync(join(tmpdir(), 'capture-'))
        initCapture(dir)
        captureDevice('dev-1', Buffer.from('aa0720e80a96bb', 'hex'))
        captureDevice('dev-1', Buffer.from('aa0720e90a91bb', 'hex'))
        captureCloud({ cloud: { x: 1 } })
        const day = new Date().toISOString().slice(0, 10)
        const devLines = readFileSync(join(dir, `dev-1-${day}.ndjson`), 'utf8')
            .trim()
            .split('\n')
        assert.equal(devLines.length, 2)
        assert.equal(JSON.parse(devLines[0]).rx, 'aa0720e80a96bb')
        const cloudLines = readFileSync(join(dir, `cloud-${day}.ndjson`), 'utf8')
            .trim()
            .split('\n')
        assert.deepEqual(JSON.parse(cloudLines[0]).cloud, { x: 1 })
    })

    test('disabled capture writes nothing', () => {
        dir = mkdtempSync(join(tmpdir(), 'capture-'))
        initCapture(null)
        captureDevice('dev-1', Buffer.from('aa', 'hex'))
        assert.equal(readdirSync(dir).length, 0)
    })

    test('retention sweep removes only ndjson files older than the cutoff', () => {
        dir = mkdtempSync(join(tmpdir(), 'capture-'))
        const old = join(dir, 'dev-1-2026-01-01.ndjson')
        const fresh = join(dir, 'dev-1-2026-06-12.ndjson')
        const other = join(dir, 'keep.txt')
        for (const f of [old, fresh, other]) writeFileSync(f, 'x')
        const past = (Date.now() - (RETENTION_DAYS + 5) * 24 * 3600 * 1000) / 1000
        utimesSync(old, past, past)
        utimesSync(other, past, past)
        sweepOldCaptures(dir)
        const left = readdirSync(dir).sort()
        assert.deepEqual(left, ['dev-1-2026-06-12.ndjson', 'keep.txt'])
    })
})
