import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { StageFSM, WASHER_TABLE, DRYER_TABLE, type Stage } from '@/cloud/devices/stage_fsm'
import { captureLog } from '@/tests/helpers/mocks'

function washerFsm(initial: Stage = 'Off') {
    const published: Stage[] = []
    const fsm = new StageFSM('test-id', WASHER_TABLE, initial, (s) => published.push(s))
    return { fsm, published }
}

function dryerFsm(initial: Stage = 'Off') {
    const published: Stage[] = []
    const fsm = new StageFSM('dryer-id', DRYER_TABLE, initial, (s) => published.push(s))
    return { fsm, published }
}

describe('StageFSM (washer table)', () => {
    test('normal cycle: Off→Washing→Rinsing→Spinning→Done→Off', () => {
        const { fsm, published } = washerFsm()
        for (const e of ['cycleActive', 'rinsePhase', 'spinPhase', 'ended', 'standby'] as const) fsm.dispatch(e)
        assert.deepEqual(published, ['Washing', 'Rinsing', 'Spinning', 'Done', 'Off'])
    })

    test('repeated events are silent self-loops (no republish)', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('cycleActive')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Washing'])
    })

    test('ended while Off is ignored and logged — no false Done', (t) => {
        const spy = captureLog(t)
        const { fsm, published } = washerFsm()
        fsm.dispatch('ended')
        assert.deepEqual(published, [])
        assert.equal(fsm.stage, 'Off')
        const logged = spy.mock.calls.map((c) => c.arguments.join(' ')).join('\n')
        assert.match(logged, /illegal stage event.*ended.*Off/)
    })

    test('Done latches: repeated ended produces exactly one Done edge', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('ended')
        fsm.dispatch('ended')
        fsm.dispatch('ended')
        assert.deepEqual(published, ['Washing', 'Done'])
    })

    test('pause remembers prior stage and resumes to it', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('rinsePhase')
        fsm.dispatch('paused')
        fsm.dispatch('cycleActive') // resume
        assert.deepEqual(published, ['Washing', 'Rinsing', 'Paused', 'Rinsing'])
    })

    test('ended while Paused → Done (cycle finished while user fiddled)', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('paused')
        fsm.dispatch('ended')
        assert.deepEqual(published, ['Washing', 'Paused', 'Done'])
    })

    test('standby mid-cycle aborts without Done (cancelled cycle)', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('standby')
        assert.deepEqual(published, ['Washing', 'Off'])
    })

    test('backward transition (rinsePhase while Spinning) ignored and logged once', (t) => {
        const spy = captureLog(t)
        const { fsm } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('rinsePhase')
        fsm.dispatch('spinPhase')
        fsm.dispatch('rinsePhase')
        fsm.dispatch('rinsePhase')
        assert.equal(fsm.stage, 'Spinning')
        const hits = spy.mock.calls.filter((c) => c.arguments.join(' ').includes('rinsePhase'))
        assert.equal(hits.length, 1)
    })

    test('new cycle from Done: cycleActive → Washing', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('ended')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Washing', 'Done', 'Washing'])
    })

    test('initial state can be seeded (persistence restore)', () => {
        const { fsm, published } = washerFsm('Rinsing')
        assert.equal(fsm.stage, 'Rinsing')
        fsm.dispatch('ended')
        assert.deepEqual(published, ['Done'])
    })

    test('restored-Paused resume: cycleActive falls back to cycle-start stage (Washing)', () => {
        // pausedFrom is null after restart; safe restart point is Off.cycleActive target
        const { fsm, published } = washerFsm('Paused')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Washing'])
    })

    test('offTimeout from Done → Off', () => {
        const { fsm, published } = washerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('ended')
        fsm.dispatch('offTimeout')
        assert.deepEqual(published, ['Washing', 'Done', 'Off'])
    })
})

describe('StageFSM (dryer table)', () => {
    test('normal cycle: Off→Heating→Drying→Cooling→Done→Off', () => {
        const { fsm, published } = dryerFsm()
        for (const e of ['cycleActive', 'dryPhase', 'coolPhase', 'ended', 'offTimeout'] as const) fsm.dispatch(e)
        assert.deepEqual(published, ['Heating', 'Drying', 'Cooling', 'Done', 'Off'])
    })

    test('re-heat after resume: Drying + heatPhase → Heating (legal)', () => {
        const { fsm, published } = dryerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('dryPhase')
        fsm.dispatch('heatPhase')
        assert.deepEqual(published, ['Heating', 'Drying', 'Heating'])
    })

    test('pause from Heating and resume back to Heating', () => {
        const { fsm, published } = dryerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('paused')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Heating', 'Paused', 'Heating'])
    })

    test('pause from Drying and resume back to Drying', () => {
        const { fsm, published } = dryerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('dryPhase')
        fsm.dispatch('paused')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Heating', 'Drying', 'Paused', 'Drying'])
    })

    test('pause from Cooling and resume back to Cooling', () => {
        const { fsm, published } = dryerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('coolPhase')
        fsm.dispatch('paused')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Heating', 'Cooling', 'Paused', 'Cooling'])
    })

    test('heatPhase while Cooling is illegal — state stays Cooling', (t) => {
        captureLog(t)
        const { fsm, published } = dryerFsm()
        fsm.dispatch('cycleActive')
        fsm.dispatch('coolPhase')
        fsm.dispatch('heatPhase')
        assert.equal(fsm.stage, 'Cooling')
        assert.deepEqual(published, ['Heating', 'Cooling'])
    })

    test('restored-Paused resume: cycleActive falls back to cycle-start stage (Heating)', () => {
        // pausedFrom is null after restart; safe restart point is Off.cycleActive target
        const { fsm, published } = dryerFsm('Paused')
        fsm.dispatch('cycleActive')
        assert.deepEqual(published, ['Heating'])
    })
})
