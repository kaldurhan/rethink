// Raw-traffic capture for protocol research (config option `capture_raw`).
// Appends ndjson per device/day under the capture dir; the cloud feed gets
// its own file. Survives add-on restarts and never goes stale — unlike the
// management debug WebSockets, which die silently on restarts (the failure
// that cost the 2026-06-12 dryer-energy correlation its cloud reference).
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import log from '@/util/logging'

// Capture files older than this are deleted at startup — capture mode left
// on permanently writes a few MB/day per device and would otherwise grow
// unbounded in /data.
export const RETENTION_DAYS = 14

let captureDir: string | null = null

export function initCapture(dir: string | null) {
    captureDir = dir
    if (dir) {
        mkdirSync(dir, { recursive: true })
        sweepOldCaptures(dir)
        log('status', `raw capture enabled → ${dir}`)
    }
}

export function sweepOldCaptures(dir: string, now = Date.now()) {
    const cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000
    let removed = 0
    try {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.ndjson')) continue
            const path = join(dir, name)
            if (statSync(path).mtimeMs < cutoff) {
                unlinkSync(path)
                removed++
            }
        }
    } catch (err) {
        log('status', `capture retention sweep failed: ${err}`)
    }
    if (removed) log('status', `capture retention: removed ${removed} file(s) older than ${RETENTION_DAYS} days`)
}

export function captureEnabled(): boolean {
    return captureDir !== null
}

function append(name: string, record: object) {
    if (!captureDir) return
    const day = new Date().toISOString().slice(0, 10)
    try {
        appendFileSync(join(captureDir, `${name}-${day}.ndjson`), JSON.stringify(record) + '\n')
    } catch (err) {
        // capture must never break decoding — disable on persistent failure
        log('status', `capture write failed, disabling: ${err}`)
        captureDir = null
    }
}

export function captureDevice(id: string, buf: Buffer) {
    if (!captureDir) return
    append(id, { t: new Date().toISOString().slice(11, 19), rx: buf.toString('hex') })
}

export function captureCloud(message: object) {
    if (!captureDir) return
    append('cloud', { t: new Date().toISOString().slice(11, 19), ...message })
}
