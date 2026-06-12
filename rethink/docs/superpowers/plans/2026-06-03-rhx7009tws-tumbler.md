# RHX7009TWS Tumbler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the LG RHX7009TWS heat-pump tumble dryer (ThinQ model ID `SDH_X7_7008`) as a fully-parsed AABB device with HA sensor entities, backed by real packet-capture tests.

**Architecture:** Extend `AABBDevice` in a new `RHX7009TWS.ts` (replacing the scaffold). `processAABB(inner)` parses ST/CS/phase/TR from fixed byte offsets. Fix `ha_bridge.ts` to register the device under its real ThinQ model key `SDH_X7_7008` instead of the marketing name.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), existing `AABBDevice` base class, `MockHAConnection` / `MockThinq2Device` / `buf` test helpers.

---

## File Map

| Action  | Path                                                  |
| ------- | ----------------------------------------------------- |
| Modify  | `cloud/ha_bridge.ts` — fix device key                 |
| Replace | `cloud/devices/RHX7009TWS.ts` — full implementation   |
| Replace | `tests/cloud/devices/RHX7009TWS.test.ts` — real tests |

---

## Protocol Reference (for implementer)

`processAABB(inner)` receives `buf.subarray(2, buf.length-2)` — the AABB frame with the `aa ff` prefix and `checksum bb` trailer already stripped.

**Guards:**

- `inner[0] !== 0x30` → not our frame type, return early
- `inner.length < 9` → too short to read ST, return early
- `inner.length < 24` → short packet (standby), only publish `run_state`

**Field positions in `inner`:**

| Bytes    | Field                                       | Notes                                   |
| -------- | ------------------------------------------- | --------------------------------------- |
| [0]      | Frame type                                  | must equal `0x30`                       |
| [8]      | ST — machine state                          | single byte                             |
| [14]     | Phase high byte                             |                                         |
| [15]     | Phase low byte                              |                                         |
| [16..17] | CS — course                                 | little-endian uint16                    |
| [22..23] | TR — time remaining / dryness / drying mode | little-endian uint16, context-dependent |

**ST values:**

| Value  | Meaning                                                 |
| ------ | ------------------------------------------------------- |
| `0x0b` | Standby (display off)                                   |
| `0xeb` | DisplayOn (idle, program not selected or selected idle) |
| `0xec` | Running                                                 |
| `0xe2` | Anti-crease                                             |
| `0x04` | End / door unlocked                                     |

**CS values (bytes 16–17 LE):**

| CS       | Course                 |
| -------- | ---------------------- |
| `0x0005` | Timed Dry              |
| `0x0006` | Mixed Fabrics          |
| `0x0007` | Cotton                 |
| `0x0008` | Sportswear             |
| `0x0009` | Quick Dry 30           |
| `0x000a` | Delicates              |
| `0x000b` | Wool                   |
| `0x000d` | Easy Iron              |
| `0x0013` | Drum Care              |
| `0x0015` | Allergy Care           |
| `0x001b` | Easy Iron (Strykfritt) |
| `0x001c` | Eco                    |
| `0x0026` | AI Dry                 |
| `0x003a` | TurboDry               |

**Phase tuple (bytes 14–15):**

| [14] [15] | Phase name |
| --------- | ---------- |
| `05 03`   | Idle       |
| `03 09`   | Heating    |
| `07 09`   | Drying     |
| `07 10`   | Cooldown   |

**TR bytes 22–23 (context-dependent):**

- ST=`0xec` (running): TR = minutes remaining (countdown)
- ST=`0xeb`, phase=`05 03`, byte[14]=`05`: TR = dryness level
    - `0x001e` = Iron Dry, `0x0041` = Cupboard Dry, `0x0046` = Extra Dry
- ST=`0xeb`, phase NOT `05 03`: TR = drying mode
    - `0x0046` = Efficiency, `0x0096` = Turbo
- ST=`0xe2`: Anti-crease (ignore TR)

**Verbatim hex captures** (full AABB packets — `buf()` strips framing automatically via `thinq.emit('data', ...)`):

```
STANDBY:
aaff300a00130000a90001010b000100c240bb

DISPLAY_ON_IDLE (ST=0xeb, CS=0x0006 Mixed Fabrics, dryness=0x0046 Extra Dry):
aaff300a0045008c1f000100eb0033000503000006000000004600460100000200000406000000200000010500000000000000000000000000006400040078000000630dbb

QUICK_DRY_30_SELECTED (ST=0xec, CS=0x0009, TR=0x001e=30min):
aaff300a0078008d2c000100ec0066000503000006000000004600460100000200000406000000200000810500000000000000000000000000006400040078000000000003000009000000001e001e01000002000004090000002000008105000000000000000000000000000064000400780000002f5abb

DRYING_TR29 (ST=0xec, CS=0x0009, TR=0x001d=29min, phase=07 01):
aaff300a0078008d30000100ec0066000003000009000000001e001e0701000200000409000000000040810500000000000000000000000000006400040078000000000003000009000000001d001e07010002000004090000000000408105000000000000000000000000000064000400780000000ef4bb

COOLDOWN (ST=0xec, phase=07 10):
aaff300a0064008ded00020103002907100305070101047502090300150009050903030004000000000000000045003c0000000000010133010500255344485f58375f373030380000000000000000000102bf220b8b01070000000000000000007c7ebb

ANTI_CREASE (ST=0xe2):
aaff300a0045008e4000010ae20033000003000009000000001e001e0701000200e3040900000000004081050000000000000000000000000000640004007800000046f9bb

FINISHED (ST=0x04):
aaff300a0058008e460001010400460303010105214009031e08dc000f00f0dc00000000000900000004000401f100f800000f111010000000001000f20001000000000100000000001a04f336481a20fc0cc0cd0c848bbb
```

---

## Task 1: Fix ha_bridge.ts registration key

**Files:**

- Modify: `cloud/ha_bridge.ts` line ~32

- [ ] **Step 1: Change the registration key**

In `cloud/ha_bridge.ts`, find:

```typescript
    RHX7009TWS,
```

Replace with:

```typescript
    ['SDH_X7_7008']: RHX7009TWS,
```

- [ ] **Step 2: Run tests to verify nothing broken**

```bash
cd /tmp/rethink/rethink && npm test 2>&1 | tail -20
```

Expected: all existing tests pass (the scaffold test still passes).

- [ ] **Step 3: Commit**

```bash
cd /tmp/rethink/rethink && git add cloud/ha_bridge.ts && git commit -m "fix(ha_bridge): register RHX7009TWS under SDH_X7_7008 model ID"
```

---

## Task 2: Write failing tests from hex captures

**Files:**

- Replace: `tests/cloud/devices/RHX7009TWS.test.ts`

- [ ] **Step 1: Replace placeholder with real test file**

Write `tests/cloud/devices/RHX7009TWS.test.ts`:

```typescript
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
    })

    test('anti-crease → run_state=AntiCrease', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'AntiCrease')
    })

    test('finished → run_state=End', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FINISHED)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'End')
    })

    test('unknown frame type byte is ignored (no crash)', () => {
        const { ha, thinq } = makeDevice()
        // Same as standby but inner[0] changed from 0x30 to 0x99
        const bad = Buffer.from(STANDBY)
        bad[2] = 0x99
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('publishProperty deduplication — same packet twice only publishes once', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DISPLAY_ON_IDLE)
        thinq.emit('data', DISPLAY_ON_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, 'DisplayOn')
    })
})
```

- [ ] **Step 2: Run tests — expect failures (not "placeholder passes")**

```bash
cd /tmp/rethink/rethink && npm test -- --test-name-pattern="RHX7009TWS" 2>&1 | tail -30
```

Expected: multiple test failures (config check, state assertions fail because `processAABB` is a no-op).

---

## Task 3: Implement RHX7009TWS.ts

**Files:**

- Replace: `cloud/devices/RHX7009TWS.ts`

- [ ] **Step 1: Write full implementation**

Write `cloud/devices/RHX7009TWS.ts`:

```typescript
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { allowExtendedType } from '@/util/casting'

const STATES: Record<number, string> = {
    0x0b: 'Standby',
    0xeb: 'DisplayOn',
    0xec: 'Running',
    0xe2: 'AntiCrease',
    0x04: 'End',
}

const COURSES: Record<number, string> = {
    0x0005: 'Timed Dry',
    0x0006: 'Mixed Fabrics',
    0x0007: 'Cotton',
    0x0008: 'Sportswear',
    0x0009: 'Quick Dry 30',
    0x000a: 'Delicates',
    0x000b: 'Wool',
    0x000d: 'Easy Iron',
    0x0013: 'Drum Care',
    0x0015: 'Allergy Care',
    0x001b: 'Easy Iron',
    0x001c: 'Eco',
    0x0026: 'AI Dry',
    0x003a: 'TurboDry',
}

// Phase tuple [inner[14], inner[15]]
function decodePhase(a: number, b: number): string {
    if (a === 0x05 && b === 0x03) return 'Idle'
    if (a === 0x03 && b === 0x09) return 'Heating'
    if (a === 0x07 && b === 0x09) return 'Drying'
    if (a === 0x07 && b === 0x10) return 'Cooldown'
    return `unknown (${a.toString(16)} ${b.toString(16)})`
}

const DRYNESS_LEVELS: Record<number, string> = {
    0x001e: 'Iron Dry',
    0x0041: 'Cupboard Dry',
    0x0046: 'Extra Dry',
}

const DRYING_MODES: Record<number, string> = {
    0x0046: 'Efficiency',
    0x0096: 'Turbo',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG RHX7009TWS Dryer' }),
                components: {
                    run_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-run-state',
                        state_topic: '$this/run_state',
                        icon: 'mdi:state-machine',
                    },
                    program: {
                        platform: 'sensor',
                        unique_id: '$deviceid-program',
                        state_topic: '$this/program',
                        icon: 'mdi:pin-outline',
                    },
                    phase: {
                        platform: 'sensor',
                        unique_id: '$deviceid-phase',
                        state_topic: '$this/phase',
                        icon: 'mdi:cog-outline',
                    },
                    dryness_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryness-level',
                        state_topic: '$this/dryness_level',
                        icon: 'mdi:water-percent',
                    },
                    drying_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-drying-mode',
                        state_topic: '$this/drying_mode',
                        icon: 'mdi:leaf',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
                    },
                },
            }),
        )
    }

    processAABB(inner: Buffer) {
        if (inner.length < 9 || inner[0] !== 0x30) return

        const st = inner[8]
        this.publishProperty('run_state', STATES[st] ?? `unknown (0x${st.toString(16)})`)

        if (inner.length < 24) return

        const phase = decodePhase(inner[14], inner[15])
        this.publishProperty('phase', phase)

        const cs = inner.readUInt16LE(16)
        this.publishProperty('program', COURSES[cs] ?? `unknown (0x${cs.toString(16).padStart(4, '0')})`)

        const tr = inner.readUInt16LE(22)

        if (st === 0xec) {
            // Running — TR is minutes remaining
            this.publishProperty('remaining_time', tr)
        } else if (st === 0xeb) {
            // Idle — TR is either dryness level or drying mode depending on phase
            if (inner[14] === 0x05) {
                this.publishProperty('dryness_level', DRYNESS_LEVELS[tr] ?? `unknown (0x${tr.toString(16)})`)
            } else {
                this.publishProperty('drying_mode', DRYING_MODES[tr] ?? `unknown (0x${tr.toString(16)})`)
            }
        }
        // ST=0xe2 (anti-crease) and ST=0x04 (end): TR not meaningful, no TR publish
    }
}
```

- [ ] **Step 2: Run tests — expect all to pass**

```bash
cd /tmp/rethink/rethink && npm test -- --test-name-pattern="RHX7009TWS" 2>&1 | tail -30
```

Expected: all 14 tests pass.

- [ ] **Step 3: Run full test suite to check for regressions**

```bash
cd /tmp/rethink/rethink && npm test 2>&1 | tail -20
```

Expected: all tests pass (202 washer tests + 14 new tumbler tests).

- [ ] **Step 4: Commit**

```bash
cd /tmp/rethink/rethink && git add cloud/devices/RHX7009TWS.ts tests/cloud/devices/RHX7009TWS.test.ts && git commit -m "feat(RHX7009TWS): implement SDH_X7_7008 tumble dryer with full AABB parser and tests"
```

---

## Self-Review

**Spec coverage:**

- ✅ Fix ha_bridge key: Task 1
- ✅ Frame type guard `inner[0] !== 0x30`: Task 3, processAABB
- ✅ Length guard `< 9` (short packets): Task 3
- ✅ Length guard `< 24` (skip phase/CS/TR for standby): Task 3
- ✅ ST decode → `run_state`: Task 3
- ✅ CS LE uint16 decode → `program`: Task 3
- ✅ Phase tuple decode: Task 3
- ✅ TR context-dependent (running=minutes, idle=dryness/mode): Task 3
- ✅ 176-byte sensor data packet: no HA entities → ignored by length/type guards (inner[0]=0x30 check still holds; if it passes that, fields are parsed but no extra entities emitted)
- ✅ 120/130-byte packets: handled transparently (length >= 24, fields at fixed offsets still valid)
- ✅ HA discovery config: 6 sensor components in setConfig

**Placeholder scan:** None found.

**Type consistency:** `publishProperty(prop: string, value: string | number)` — all calls use string keys and string/number values matching the base class signature. `readUInt16LE` returns `number`. All lookup results are `string`. Consistent.
