import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { storePath } from '@/cloud/devices/stage_store'
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

// Captured from real device: info-class packet (inner[8]=0x02) emitted while
// cycle is paused. ST=0x03 in this context means Paused, not Cooldown.
const PAUSED_INFO_CLASS = buf(
    'aaff300a00510093b20002010300160c1003050c010804ce030604000f0013040000000305010500255344485f58375f373030380000000000000000000102c08a7848060700000000000000000035edbb',
)

// Captured from real Mixed Fabrics cycle at 15:43:45 — TR=70 loaded, phA=01 phB=00.
// Lasts ~8 s before heating starts (phase transitions to Drying immediately after).
const STARTUP_TR70 = buf(
    'aaff300a007800a466000100ec0066000000000006000000000000000100000000000406000000000000810500000000000000000000000000006400040078000000000503000006000000004600460100000200000406000000200000810500000000000000000000000000006400040078000000ae2ebb',
)

// Captured at 19:05:32 — first packet where phA=07 phB=11 (Cooldown phase begins at TR=10).
// Cool-air tumble continues TR=10→3 (~17 min) before Finishing.
const COOLDOWN_PHASE = buf(
    'aaff300a007800acd3000100ec0066000503000006000000000b00461100000307670406000000000060810500000000000000000000000000006400040078000000000503000006000000000b004607110003076d040600000000004081050000000000000000000000000000640004007800000066cdbb',
)

// Captured at 19:22:52 (TR=2, phA=11 phB=00) then 19:22:53 (TR=1, phA=08 phB=11).
// Both map to Finishing — brief end-of-cooldown states before anti-crease.
const FINISHING_TR2 = buf(
    'aaff300a007800ad7c000100ec0066000503000006000000000300460711000407f60406000000000040810500000000000000000000000000006400040078000000000503000006000000000200461100000507ff0406000000000060810500000000000000000000000000006400040078000000d850bb',
)
const FINISHING_TR1 = buf(
    'aaff300a007800ad7e000100ec0066000503000006000000000200461100000507ff0406000000000060810500000000000000000000000000006400040078000000000503000006000000000100460811000508000406000000000060810500000000000000000000000000006400040078000000839ebb',
)

// Running packet with TR=0 in sub2 — the post-cycle anti-wrinkle tumble.
// Captured at 12:38:35 immediately after the End packet.
const POST_CYCLE_TUMBLE = buf(
    'aaff300a0078009171000100ec00660000030000090000000001001e0400000701180409000000200000810500000000000000000000000000006400040078000000000000000009000000000000000004000001180409000000200000810500000000000000000000000000006400040078000000ed9bbb',
)

const ANTI_CREASE = buf(
    'aaff300a0045008e4000010ae20033000003000009000000001e001e0701000200e3040900000000004081050000000000000000000000000000640004007800000046f9bb',
)

// Captured live 2026-06-11 18:51:23 — five seconds after the AntiCrease packet
// ended the cycle, the dryer emitted a double-block Running packet whose
// authoritative sub2 carries TR=1 (defeating the TR=0 post-cycle-tumble guard)
// and the unknown phase tuple (04,00) — anti-crease chatter mid-transition.
// On 1.0.59 this restarted the stage machine (Done → Heating) and the End
// packet 21 s later produced a second Done edge.
const ANTICREASE_TUMBLE_TR1 = buf(
    'aaff300a007800b8f0000100ec00660000030000090000000001001e0811000500fa04090000000000408105000000000000000000000000000064000400780000000000030000090000000001001e0400000700fc0409000000200000810500000000000000000000000000006400040078000000a5a2bb',
)

// Captured live 2026-06-11 18:51:44 — the End packet that followed the
// anti-crease tumble above (course 0x21 'Auto Dry', same as FINISHED).
const FINISHED_AUTODRY = buf(
    'aaff300a005800b8f40001010400460303010105214009031e09dc000f00f0dc00000000000900000004000401f1010300000f111010000000101000f20001000000000100000000001a04f336481a24e40cc0cd0c1fb4bb',
)

const FINISHED = buf(
    'aaff300a0058008e460001010400460303010105214009031e08dc000f00f0dc00000000000900000004000401f100f800000f111010000000001000f20001000000000100000000001a04f336481a20fc0cc0cd0c848bbb',
)

// Synthetic fixtures: no real capture of drying-mode browsing exists yet, so
// these derive from DISPLAY_ON_IDLE with phA (inner[14]) forced ≠0x05 and TR
// (inner[23]) set to a drying-mode byte. processData does not verify the
// checksum, so byte mutation is safe. Replace with real captures when taken.
function withInnerBytes(src: Buffer, edits: Record<number, number>): Buffer {
    const copy = Buffer.from(src)
    for (const [innerIdx, val] of Object.entries(edits)) copy[Number(innerIdx) + 2] = val
    return copy
}
const DISPLAY_ON_MODE_TURBO = withInnerBytes(DISPLAY_ON_IDLE, { 14: 0x01, 23: 0x96 })
const DISPLAY_ON_MODE_EFFICIENCY = withInnerBytes(DISPLAY_ON_IDLE, { 14: 0x01, 23: 0x46 })
const DISPLAY_ON_MODE_UNKNOWN = withInnerBytes(DISPLAY_ON_IDLE, { 14: 0x01, 23: 0x12 })

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    // Wipe persisted stage between tests — all devices use the same DEVICE_ID
    // ('test-id') so state written in one test leaks into the next via stage-state.json.
    beforeEach(() => {
        const p = storePath()
        if (existsSync(p)) rmSync(p)
    })

    test('device instantiates without throwing', () => {
        const { dev } = makeDevice()
        assert.ok(dev)
    })

    test('config exposes expected sensor components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID]?.config?.components as Record<string, Record<string, unknown>>
        assert.ok(cfg, 'config.components should be set on construction')
        assert.ok('run_state' in cfg, 'run_state component missing')
        assert.ok('program' in cfg, 'program component missing')
        assert.ok('phase' in cfg, 'phase component missing')
        assert.ok('remaining_time' in cfg, 'remaining_time component missing')
        // run_state must be an enum so HA shows the available states dropdown.
        assert.equal(cfg.run_state.device_class, 'enum')
        const opts = cfg.run_state.options as string[]
        assert.ok(opts.includes('Standby'))
        assert.ok(opts.includes('Running'))
        assert.ok(opts.includes('Paused'))
        assert.ok(opts.includes('Cooldown'))
        assert.ok(opts.includes('AntiCrease'))
        assert.ok(opts.includes('End'))
        assert.ok(!opts.includes('DisplayOn'), 'DisplayOn must not appear in options')
    })

    test('standby packet → run_state=Standby', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    test('display-on-idle → run_state falls back to Standby (clears stale retained message), program=Mixed Fabrics', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        // Fresh device: cache is empty, so DisplayOn publishes Standby to flush any stale retained value.
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.program, 'Mixed Fabrics')
    })

    test('display-on during running → run_state stays Running (cache-check guards mid-cycle)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29) // real mid-cycle packet establishes Running
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        thinq.emit('data', DISPLAY_ON_IDLE)
        // Cache has 'Running' → DisplayOn must not overwrite it.
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('display-on-idle → phase=Idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Idle')
    })

    test('display-on with phA≠0x05 TR=0x96 → drying_mode=Turbo, dryness_level untouched', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_MODE_TURBO)
        assert.equal(ha.devices[DEVICE_ID].properties.drying_mode, 'Turbo')
        assert.equal(ha.devices[DEVICE_ID].properties.dryness_level, undefined)
    })

    test('display-on with phA≠0x05 TR=0x46 → drying_mode=Efficiency (same TR byte as Extra Dry dryness)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_MODE_EFFICIENCY)
        assert.equal(ha.devices[DEVICE_ID].properties.drying_mode, 'Efficiency')
        assert.equal(ha.devices[DEVICE_ID].properties.dryness_level, undefined)
    })

    test('display-on with phA≠0x05 and unmapped TR → drying_mode falls back to unknown hex', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_MODE_UNKNOWN)
        assert.equal(ha.devices[DEVICE_ID].properties.drying_mode, 'unknown (0x12)')
    })

    test('display-on-idle → dryness_level=Extra Dry (TR=0x0046 in idle context)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.dryness_level, 'Extra Dry')
    })

    test('quick-dry-30 selected → run_state falls back to Standby, program=Quick Dry 30', () => {
        // Selection chatter (ST=0xec, phase Idle/Startup) is treated like
        // DisplayOn since the trailing-selection-packet freeze observed live
        // 2026-06-11: fresh cache → Standby, never Running.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.program, 'Quick Dry 30')
    })

    test('trailing selection packet after standby does not flip run_state back to Running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Standby')
    })

    // Captured live 2026-06-11 14:54 — door open/close and panel power on the
    // IDLE dryer emit info-class ST=0x03 bursts with sub-state codes 0x10
    // (door) and 0x0e (panel), mirrored at inner[13]/inner[17]. Real pauses
    // (code 0x0c) arrive only in the short user-event packet shape
    // (inner[12]=0x16); codes in larger info packets are progress chatter.
    const IDLE_DOOR_INFO = buf(
        'aaff300a005100b74e0002010300161010030510000005e100000000000000000000000000010500255344485f58375f373030380000000000000000000102c2220b8b01070000000000000000006b72bb',
    )
    const IDLE_PANEL_INFO = buf(
        'aaff300a005900b75300020103001e0e1003050e010d05e3000602000000460000000000000200000103000000010500255344485f58375f373030380000000000000000000102c2220b8b01070000000000000000006ea7bb',
    )

    test('idle door/panel info packets (codes 0x10/0x0e) are NOT a pause', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', IDLE_DOOR_INFO)
        thinq.emit('data', IDLE_PANEL_INFO)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    // Captured live 2026-06-11 18:41:57 mid-Drying with the door untouched
    // (user-confirmed): a len=96 info packet ([12]=0x29) whose counter at
    // [13]/[17] happened to read 0x07 — the same value once misread as a
    // "door-open pause" code. The counter walked 0x07→0x08→0x09 across the
    // cycle; only this first value collided with the pause set, flipping
    // run_state/stage to Paused for 1 s on 1.0.59/1.0.60.
    const SPURIOUS_INFO_07 = buf(
        'aaff300a006400b8960002010300290710030507010e05f402090300150009090903030004000000000000000045003c0000000000010108010500255344485f58375f373030380000000000000000000102c3220b8b0107000000000000000000b80abb',
    )

    test('mid-cycle info chatter with counter byte 0x07 (len=96 shape) is NOT a pause', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
        thinq.emit('data', SPURIOUS_INFO_07)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
    })

    // Real mid-cycle door pause, captured live 2026-06-12 13:31–13:32:
    // pause (code 0x0c) → door open ([31]=0x01) → door close ([31]=0x00)
    // → resume. The pause code for a DOOR pause is 0x0c — same as panel
    // pause; the provisional 0x07 never appeared.
    const MIDCYCLE_PAUSE_0C = buf(
        'aaff300a005100bbdf0002010300160c1003050c01100634030603000e0038040000000504010500255344485f58375f373030380000000000000000000102c38a784806070000000000000000009fcebb',
    )
    const MIDCYCLE_DOOR_OPEN = buf(
        'aaff300a005100bbe100020103001610100305100000063500000000000000000001000000010500255344485f58375f373030380000000000000000000102c58a7848060700000000000000000097eabb',
    )
    const MIDCYCLE_DOOR_CLOSE = buf(
        'aaff300a005100bbe200020103001610100305100000063600000000000000000000000000010500255344485f58375f373030380000000000000000000102c78a78480607000000000000000000ffa5bb',
    )

    test('mid-cycle door pause (code 0x0c) → run_state=Paused, stage=Paused', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
        thinq.emit('data', MIDCYCLE_PAUSE_0C)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Paused')
    })

    test('door event [31]=0x01 → door=open; [31]=0x00 → door=closed; run_state untouched', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', MIDCYCLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'open')
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
        thinq.emit('data', MIDCYCLE_DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'closed')
    })

    test('active Drying frame infers door=closed (close-from-sleep is silent)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', MIDCYCLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'open')
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'closed')
    })

    test('programme selection (ST=0xec, ambiguous Startup tuple) does NOT start the stage machine', () => {
        // The dryer broadcasts ST=0xec with phase tuple 0x0100 (Startup) while
        // a programme is merely selected on the panel — the same tuple a real
        // cycle shows for its first ~8 s. Only Heating/Drying may start stage.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
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

    test('startup phase (0x0100) TR=70 → run_state lags at Standby, phase=Startup, remaining_time=70', () => {
        // Startup (0x0100) is byte-identical to programme selection, so
        // run_state deliberately lags ~8 s at a real cycle start: it stays
        // Standby until the first Heating/Drying packet. Stage drives the
        // automations, so the lag is cosmetic.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STARTUP_TR70)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Standby')
        assert.equal(p.phase, 'Startup')
        assert.equal(p.remaining_time, 70)
        assert.equal(p.program, 'Mixed Fabrics')
    })

    test('cooldown phase (0x0711) → run_state=Running, phase=Cooldown, remaining_time=11', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COOLDOWN_PHASE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.run_state, 'Running')
        assert.equal(p.phase, 'Cooldown')
        assert.equal(p.remaining_time, 11)
        assert.equal(p.program, 'Mixed Fabrics')
    })

    test('finishing phases (0x1100 TR=2 then 0x0811 TR=1) → phase=Finishing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FINISHING_TR2)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Finishing')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 2)
        thinq.emit('data', FINISHING_TR1)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Finishing')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 1)
    })

    test('info-class ST=0x03 cooldown chatter (len=96 shape, counter 0x07) publishes nothing', () => {
        // This fixture was captured during a real cooldown on 2026-06-03 and
        // was briefly misread as a door-open pause — its [13]/[17] counter
        // value 0x07 collided with the pause set. It is routine chatter:
        // same shape as SPURIOUS_INFO_07 above.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COOLDOWN)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.program, undefined)
    })

    test('info-class ST=0x03 while running → run_state=Paused (not Cooldown)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29) // real mid-cycle packet establishes Running
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
        thinq.emit('data', PAUSED_INFO_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Paused')
    })

    test('info-class pause does not update program or phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        thinq.emit('data', PAUSED_INFO_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.program, 'Quick Dry 30')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 30)
    })

    test('Running after Paused → run_state=Running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUICK_DRY_30_SELECTED)
        thinq.emit('data', PAUSED_INFO_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Paused')
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('anti-crease → run_state=AntiCrease', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('finished → run_state=End; End packets do not update program', () => {
        // End packets carry 0x21 at the course offset — not a real course
        // (the cloud panel list has exactly 13, all byte-correlated during
        // the 2026-06-11 knob scroll). program retains what actually ran.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.program, 'Quick Dry 30')
        thinq.emit('data', FINISHED)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.program, 'Quick Dry 30')
    })

    // Captured live 2026-06-11 19:50–19:51 during the full programme-knob
    // scroll, cloud-correlated in real time. These five corrected the table:
    // 0x2c=AI_COURSE (was wrongly 0x26), 0x19=COTTONPLUS/panel "Eko" (was
    // wrongly 0x1c), 0x05=EASYCARE (was "Timed Dry"), 0x15=TIMEDRY (was
    // "Allergy Care"), 0x10=ALLERGYCARE (was missing).
    const SCROLL_AI = buf(
        'aaff300a007800b91f000100ec006600000200000800000000500050010000020000040800000020000081050000000000000000000000000000640004007800000000000200002c00000000500050010000020000041c0000002000008105000000000000000000000000000064000400780000006198bb',
    )
    const SCROLL_ECO = buf(
        'aaff300a007800b923000100ec00660003030000070000000096009601000002000004070000002000008105000000000000000000000000000064000400780000000003020000190000000064006401000000000004190000002000048105000000000000000000000000000064000400780000009817bb',
    )
    const SCROLL_EASYCARE = buf(
        'aaff300a007800b926000100ec006600000200000a00000000460046010000020000040a0000002000008105000000000000000000000000000064000400780000000003030000050000000050005001000002000004050000002000008105000000000000000000000000000064000400780000009cbabb',
    )
    const SCROLL_TIMEDRY = buf(
        'aaff300a007800b927000100ec0066000303000005000000005000500100000200000405000000200000810500000000000000000000000000006400040078000000000003000015000000005000500100000200000415000000200000810500000000000000000000000000006400040078000000105abb',
    )
    const SCROLL_ALLERGY = buf(
        'aaff300a007800b928000100ec006600000300001500000000500050010000020000041500000020000081050000000000000000000000000000640004007800000000000300001000000000500050010000020000041000000020000081050000000000000000000000000000640004007800000057acbb',
    )

    test('knob-scroll selections decode the corrected course bytes', () => {
        const { ha, thinq } = makeDevice()
        const expect = [
            [SCROLL_AI, 'AI Dry'],
            [SCROLL_ECO, 'Eco'],
            [SCROLL_EASYCARE, 'Easy Care'],
            [SCROLL_TIMEDRY, 'Timed Dry'],
            [SCROLL_ALLERGY, 'Allergy Care'],
        ]
        for (const [pkt, name] of expect) {
            thinq.emit('data', pkt)
            assert.equal(ha.devices[DEVICE_ID].properties.program, name)
        }
        // selection only — the stage machine must stay off
        assert.equal(ha.devices[DEVICE_ID].properties.stage, undefined)
    })

    test('unknown frame type byte is ignored (no crash)', () => {
        const { ha, thinq } = makeDevice()
        // Same as standby but inner[0] changed from 0x30 to 0x99
        const bad = Buffer.from(STANDBY)
        bad[2] = 0x99
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('post-cycle tumble (Running TR=0) is suppressed — End state preserved', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FINISHED)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
        thinq.emit('data', POST_CYCLE_TUMBLE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
    })

    test('unknown ST byte is suppressed — last known state preserved', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29) // real mid-cycle packet establishes Running
        // Mutate ST byte (inner[10] = buf[12]) to an unmapped value
        const unknown = Buffer.from(QUICK_DRY_30_SELECTED)
        unknown[12] = 0x4d
        thinq.emit('data', unknown)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('publishProperty deduplication — same packet twice only publishes once', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
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

    test('anti-crease tumble with TR=1 + unknown phase keeps stage latched at Done (live 2026-06-11 18:51)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
        thinq.emit('data', ANTI_CREASE)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Done')
        thinq.emit('data', ANTICREASE_TUMBLE_TR1)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Done', 'unknown phase must not restart the cycle')
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease', 'unknown phase must not claim Running')
        thinq.emit('data', FINISHED_AUTODRY)
        assert.equal(
            ha.devices[DEVICE_ID].properties.stage,
            'Done',
            'End after spurious restart must not yield a second Done edge',
        )
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
    })

    test('unknown phase mid-cycle leaves stage and run_state untouched', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRYING_TR29)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
        thinq.emit('data', ANTICREASE_TUMBLE_TR1)
        assert.equal(ha.devices[DEVICE_ID].properties.stage, 'Drying')
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'Running')
    })

    test('persisted active stage survives restart; End yields exactly one Done', () => {
        const first = makeDevice()
        first.thinq.emit('data', DRYING_TR29)
        assert.equal(first.ha.devices[DEVICE_ID].properties.stage, 'Drying')

        const second = makeDevice()
        second.dev.start()
        assert.equal(second.ha.devices[DEVICE_ID].properties.stage, 'Drying')
        second.thinq.emit('data', FINISHED)
        assert.equal(second.ha.devices[DEVICE_ID].properties.stage, 'Done')
    })
})
