import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import log from '@/util/logging'
import type { Stage } from '@/cloud/devices/stage_fsm'

export type StageEntry = { stage: Stage; since: number; lastDoneAt: number | null }

export function storePath(): string {
    return `${process.env.RETHINK_DATA_DIR ?? '/data'}/stage-state.json`
}

export function loadStageState(): Record<string, StageEntry> {
    try {
        return JSON.parse(readFileSync(storePath(), 'utf-8'))
    } catch {
        return {}
    }
}

export function saveStageState(id: string, entry: StageEntry) {
    try {
        const all = loadStageState()
        all[id] = entry
        const tmp = storePath() + '.tmp'
        writeFileSync(tmp, JSON.stringify(all))
        renameSync(tmp, storePath())
    } catch (err) {
        log('status', id, `failed to persist stage state: ${err}`)
    }
}
