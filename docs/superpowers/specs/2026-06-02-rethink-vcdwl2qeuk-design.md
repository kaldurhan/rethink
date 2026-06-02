# Design — Add LG F4X7511TWS (`VCDWL2QEUK`) washer to rethink

**Status:** approved (brainstorming complete), pending implementation plan
**Date:** 2026-06-02
**Author:** kaldurhan (via Claude Code)
**Target branch:** `feat/add-VCDWL2QEUK` on `kaldurhan/rethink`, opening PR upstream to `anszom/rethink:main`

## 1 — Goal and scope

Add MQTT-discovery support for the **LG F4X7511TWS** front-loading washing
machine (ThinQ model ID `VCDWL2QEUK`, AGWANE Nordic variant, ThinQ2 platform,
AABB protocol) to `rethink-cloud`. Six Home Assistant sensors are exposed.
Write commands (power, start, pause) are **out of scope for v1**: the
reverse-engineering session has not captured the appliance's write commands,
and the user explicitly chose sensors-only to avoid blind-firing F02A/F024
commands borrowed from sibling models.

### Non-goals (v1)

- Power / start / pause / remote-start writes.
- Error code enumeration (no error byte position identified).
- Door-lock state, cycle counter, energy counter, initial cycle time.
- Drying mode (the machine is washer-only — no drying phase observed in the
  Quick-14 cycle capture).

## 2 — Background and references

- rethink upstream: <https://github.com/anszom/rethink>
- Three sibling QEUK washers already in the codebase share the AABB
  protocol but use **a different code namespace** for course / temperature /
  spin and **different byte offsets** for status fields. They cannot share
  tables with this washer:

  | Field | Existing siblings | VCDWL2QEUK |
  |---|---|---|
  | Course "Cotton" | `0x01` | `0x2e` (`Bomull`) |
  | Course "Mix" | `0x07` | `0x2b` (`Blandmaterial`) |
  | Course "Eco 40-60" | `0x04` | `0x13` |
  | Course "TurboWash 39" | `0x31` | `0x7a` |
  | Status byte offset | `buf[15]` or `buf[43]` | `inner[10]` |
  | Spin offset | `buf[24]` or `buf[51]` | sub-block `sub[3]` |

- Reverse-engineering session producing the protocol map: prior Claude chat,
  2026-05-31 to 2026-06-02 (raw hex captures preserved in
  `/tmp/rethink-vcdwl2qeuk-captures/raw.json` during this design pass).

## 3 — Verified protocol structure

### 3.1 Envelope (inherited from `AABBDevice`)

`aa [length] [inner...] [checksum] bb`. For the status broadcast packets the
length byte is `0xff` (extended-length escape); `processData()` strips the
first two bytes and the last two without interpreting the length, so the
inner payload is everything between.

### 3.2 Inner layout

```
inner: [ 20  0a  00 LEN_LO LEN_HI  SEQ_LO SEQ_HI  00 01 KIND  ST  00  AUX  00  ... sub-blocks ... ]
       offset 0..13 = header                            ^── inner[10] = ST (always)
       offset 14..   = one or two 0x05-marked sub-blocks
```

- `inner[10]` always carries the machine state (`ST`). Verified across all 14
  captured packets (short standby and long display/selected/scroll captures).
- `KIND` (`inner[9]`) distinguishes short standby packets (value `0x01`,
  inner length 15, no sub-block) from long packets (value `0x00`, inner length
  ≥ 64, with sub-blocks).
- Sub-blocks begin with a `0x05` marker. Long packets carry either:
  - one device-info sub-block at `inner[14]` *and* one status sub-block later
    (seen in `cotton_40_1200_selected`, status at `inner[64]`), or
  - two status sub-blocks (steady-state and scroll captures), where during a
    UI change one block may lag and carry the previous value.

### 3.3 Status sub-block layout

```
sub: [ 0x05  PH_A  PH_B  SP  CS_LO  0x00  0..*8 zeros  TT_LO  0x00  TT_DUP  0x00 0x00 0x00  CS_REPEAT  0x01  ... ]
       0     1     2     3   4      5     6..12        13     14    15      ...
```

- `sub[0]` = `0x05` marker.
- `sub[1]` and `sub[2]` together encode the **cycle phase** (the wiki's
  "bytes 14-15"). Two-byte tuple lookup against `PHASES_VCDWL`. Spin-ramp is a
  range, not a single entry: `sub[1]=0x18 && 0x12 ≤ sub[2] ≤ 0x1f`.
- `sub[3]` = **SP** — spin speed lookup index. Verified `0x06→400`,
  `0x08→800`, `0x09→1000`, `0x0c→1200`, `0x01→1400`.
- `sub[4]` = **CS** — course code. `sub[5]` is always `0x00` (the wiki's
  "bytes 16-17 LE" reduces to a single useful byte). Verified `0x2b→Blandmaterial`;
  the remaining 12 course codes come from the scroll-order capture.
- `sub[13]` = **TT** when machine idle/selected and phase is Idle, else low
  byte of **TR** (remaining time in minutes). Verified `0x70→Cold`,
  `0x7a→20-30°C` (collision is genuine — both temperatures encode identically),
  `0x84→40°C`, `0x98→60°C`.

### 3.4 Sub-block locator strategy

A hard-coded "sub-block at `inner[14]`" assumption breaks for
`cotton_40_1200_selected` (device-info sub-block precedes the status block).
A "scan from the start" approach can latch onto the device-info block.

**Strategy:** scan from the **end** of `inner` backwards for the highest
offset where `inner[i] === 0x05` and the next 18 bytes match the sub-block
shape (`inner[i+2] !== undefined`, `inner[i+5] === 0x00`). The last sub-block
wins.

Rationale:
- Steady-state packets carry two identical sub-blocks → idempotent.
- Scroll-transition packets carry [old, new] → "last" is the fresher value.
- Boot-up packet (`cotton_40_1200_selected`) carries [device-info, status] →
  "last" is the status block.

## 4 — Architecture

### 4.1 New device file

`rethink/cloud/devices/VCDWL2QEUK.ts`, ~150 lines, extending `AABBDevice`.
All five lookup maps live inline (no edits to `washer_common.ts`).

### 4.2 Registration

Two lines added to `rethink/cloud/ha_bridge.ts`:

```diff
+import VCDWL2QEUK from './devices/VCDWL2QEUK'

 const t2deviceTypes: Record<string, T2Factory> = {
     ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
     ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
     ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
     ['F_V__F___W.B_1QEUK']: F_V__F___W_B_1QEUK,
+    ['VCDWL2QEUK']:         VCDWL2QEUK,
 }
```

### 4.3 Tests

`rethink/tests/cloud/devices/VCDWL2QEUK.test.ts` covers 14 cases against the
real hex captures. Fixture data is verbatim from the 2026-06-02 capture
session (preserved in `raw.json` during this design pass).

### 4.4 Files unchanged

`washer_common.ts`, `aabb_device.ts`, all three sibling QEUK device files,
all three sibling tests. Blast radius is two files added + one file
two-line patch.

## 5 — Data tables (inlined in `VCDWL2QEUK.ts`)

Each value below is marked `// verified` (matched against a real capture in
this session) or `// from wiki` (taken from the protocol map in the
reverse-engineering session but not yet observed in a re-captured packet).
Reviewers can prioritize verification of the latter.

```ts
// inner[10] — machine state
const STATES_VCDWL: Record<number, string> = {
  0x0b: 'Standby',        // verified
  0xeb: 'DisplayOn',      // verified
  0xec: 'Selected',       // verified
  0x04: 'Weighing',       // from wiki
}

// sub[4] — course
const COURSES_VCDWL: Record<number, string> = {
  0x2b: 'Blandmaterial',           // verified
  0x7a: 'Turbowash 39',            // from wiki (scroll order)
  0x4f: 'Sportkläder',             // from wiki
  0x55: 'Rengöring av trumman',    // from wiki
  0x4b: 'Quick 14',                // from wiki
  0x5e: 'Hand / Ull',              // from wiki
  0x2e: 'Bomull',                  // from wiki
  0x72: 'AI - Tvätt',              // from wiki
  0x13: 'Eco 40-60',               // from wiki
  0x16: 'Fintvätt',                // from wiki
  0x1d: 'Strykfritt',              // from wiki
  0x88: 'Skötsel av mikroplaster', // from wiki
  0x04: 'Allergivård',             // from wiki
}

// sub[13] — temperature (only when machine idle/selected and phase Idle)
const TEMPERATURES_VCDWL: Record<number, string> = {
  0x70: 'Cold',    // verified
  0x7a: '20-30',   // verified — collision is real
  0x84: '40',      // verified
  0x98: '60',      // verified
}

// sub[3] — spin speed
const SPINS_VCDWL: Record<number, number> = {
  0x06: 400,   // verified
  0x08: 800,   // verified
  0x09: 1000,  // verified
  0x0c: 1200,  // verified
  0x01: 1400,  // verified
}

// (sub[1] << 8) | sub[2] — cycle phase. Wiki lists multiple equivalent
// encodings per phase (e.g. `26 0b` and `0b 26` both = drain).
const PHASES_VCDWL: Record<number, string> = {
  0x0310: 'Idle',         // verified
  0x0510: 'Idle',         // from wiki
  0x0810: 'Idle',         // verified
  0x0110: 'WashFill',     // from wiki
  0x0b10: 'WashTumble',   // from wiki
  0x260b: 'WashDrain',    // from wiki
  0x0b26: 'WashDrain',    // from wiki
  0x040e: 'RinseFill',    // from wiki
  0x060e: 'RinseTumble',  // from wiki
  0x0e0c: 'RinseDrain',   // from wiki
  0x0c0e: 'RinseDrain',   // from wiki
  0x080e: 'SpinActive',   // from wiki
  0x0a0e: 'SpinActive',   // from wiki
  0x100e: 'Finished',     // from wiki
  0x0010: 'Finished',     // from wiki
  // SpinRamp handled by range check: sub[1]===0x18 && 0x12<=sub[2]<=0x1f
}
```

## 6 — Parser behaviour

```ts
processAABB(inner: Buffer) {
  if (inner.length < 11 || inner[0] !== 0x20) return

  const st = inner[10]
  this.publishProperty('machine_state', STATES_VCDWL[st] ?? 'unknown')

  // Short standby packet — no sub-block, leave other props untouched.
  if (inner.length < 32) return

  // Scan from end for the last 0x05-marked sub-block.
  const subStart = findLastSubBlock(inner)
  if (subStart < 0) return
  const sub = inner.subarray(subStart, subStart + 22)

  const phase = decodePhase(sub[1], sub[2])
  this.publishProperty('cycle_phase', phase)

  const sp = sub[3]
  this.publishProperty('spin', SPINS_VCDWL[sp] ?? 0)

  const cs = sub[4]
  this.publishProperty('course',
    COURSES_VCDWL[cs] ?? `unknown_0x${cs.toString(16).padStart(2, '0')}`)

  if ((st === 0xeb || st === 0xec) && phase === 'Idle') {
    this.publishProperty('temp',
      TEMPERATURES_VCDWL[sub[13]] ?? 'unknown')
  } else {
    const remaining = sub[13] | (sub[14] << 8)
    this.publishProperty('remaining_time', remaining)
  }
}

setProperty(_prop: string, _mqttValue: string) {
  // v1 is sensors-only; ignore HA writes.
}
```

`publishProperty` (inherited) suppresses redundant publishes via
`publishCache`, so the appliance's 2 s status broadcast does not flood MQTT.

## 7 — HA-discovery components

`setConfig(...)` publishes six MQTT-discovery components. Naming and icons
mirror the sibling washers so the rethink panel renders consistently.

| MQTT property | Platform | Device class | UoM | HA name | Icon |
|---|---|---|---|---|---|
| `machine_state` | sensor | enum | — | Machine state | `mdi:power` |
| `cycle_phase`   | sensor | enum | — | Cycle phase   | `mdi:state-machine` |
| `course`        | sensor | enum | — | Program       | `mdi:tumble-dryer` |
| `temp`          | sensor | enum | — | Temperature   | `mdi:thermometer` |
| `spin`          | sensor | —    | rpm | Spin speed   | `mdi:fan` |
| `remaining_time`| sensor | —    | min | Time remaining | `mdi:timer-outline` |

Enum options are the union of `Object.values(<map>)` plus `'unknown'` (and
for `cycle_phase` also `'SpinRamp'`, which isn't in the static map). All
properties publish with `retain: true` (inherited default).

## 8 — Tests

`rethink/tests/cloud/devices/VCDWL2QEUK.test.ts`, modeled after
`F_V__F___W.B_1QEUK.test.ts`. Mocks: `MockHAConnection`, `MockThinq2Device`,
`buf`, `hex`. Fixture hex is verbatim from the 2026-06-02 chat paste.

Test cases:

1. **config exposes expected components** — six discovery entities present.
2. **standby short packet sets machine_state=Standby** — both short captures.
3. **display-on-no-program** — `machine_state=DisplayOn`, `cycle_phase=Idle`,
   `course=Blandmaterial`, `temp=40`, `spin=400`.
4. **cotton_40_1200_selected (device-info-then-status packet)** — proves the
   end-scan locator picks the status block, not the device-info block. Note:
   the verified bytes assert `spin=400`, not the user's UI target of 1200,
   because the appliance had not yet committed the scroll into the wire
   state. Inline comment documents this.
5. **temp scroll 0x70 → Cold**.
6. **temp scroll 0x7a → '20-30'**.
7. **temp scroll 0x84 → 40**.
8. **temp scroll 0x98 → 60**.
9. **spin scroll 400 / 800 / 1000 / 1200 / 1400** — five parameterized
   assertions on `spin`.
10. **publishCache idempotency** — emit the same packet twice, observe one
    publish.
11. **frame not matching AA…BB envelope ignored**.
12. **frame with `inner[0] !== 0x20` ignored**.
13. **setProperty is a no-op** — `dev.setProperty('power', 'ON')`,
    `thinq.outbox.length === 0`.
14. **standby after display-on does not clobber prior props** — emit
    display-on then standby, assert `temp` cache still `40`.

**TODO in the test file:** add fixtures for a full Quick-14 cycle (wash →
drain → rinse → drain → spin-ramp → spin → finished) once those captures
are recovered. The 2026-06-02 chat paste truncated mid-cycle with
"Show more", so they are not currently in hand.

## 9 — Shipping path

1. Branch `feat/add-VCDWL2QEUK` cut from `kaldurhan/rethink:master`.
2. Three commits, one per logical step:
   - `feat(devices): add VCDWL2QEUK washer driver` (device file +
     `ha_bridge.ts` two-line patch)
   - `test(devices): cover VCDWL2QEUK decode against real captures` (test
     file)
   - `docs(readme): list LG F4X7511TWS (VCDWL2QEUK)` (one-line addition
     under "Washing Machines": `🫤 LG F4X7511TWS (VCDWL2QEUK), Nordic
     Front-Loading Washing Machine — sensors-only, preliminary support`)
3. CI: `npm run build` + `npm test` (node:test runner). Local pre-PR run in
   `/tmp/rethink/rethink/`.
4. Push to `kaldurhan/rethink`. Open PR titled
   `Add VCDWL2QEUK (LG F4X7511TWS) washing machine — sensors-only` against
   `anszom/rethink:main`. PR body links to a forthcoming wiki page draft at
   `https://github.com/anszom/rethink/wiki/Appliance:VCDWL2QEUK`.

## 10 — Risks and follow-ups

- **Cycle-phase coverage is wiki-grounded, not capture-grounded.** Only
  `Idle` has been observed in re-checked packets. The other phases come from
  the reverse-engineering session's notes. If a phase decodes wrong in the
  field, the symptom is `cycle_phase='unknown'` (cosmetic, not a fault).
- **The `cotton_40_1200_selected` packet contains a status sub-block
  showing `spin=400`, not `1200`.** This is a broadcast-lag artifact at the
  moment of UI commit. The test asserts the wire state honestly. If your
  Quick-14 cycle capture or any future capture shows the same lag for a
  property HA users will act on, we may want a small smoothing layer (defer
  the publish until the value stabilizes for ≥ 2 broadcasts). Out of scope
  for v1.
- **Sensors-only is a deliberate v1 constraint.** Adding writes (power /
  start / pause) requires capturing the command packets in bridge mode and
  is tracked as a v2 follow-up, not a near-term blocker.
- **Wiki update is a separate, manual step** (the upstream wiki is editable
  by anyone with a GitHub account; the maintainer historically prefers wiki
  edits to come alongside code PRs).

## 11 — Acceptance criteria

- `npm run build` and `npm test` succeed in `/tmp/rethink/rethink/` on the
  feature branch.
- All 14 test cases pass against the captured fixtures.
- Manual smoke test against the appliance shows `machine_state` reflecting
  the panel state in HA, and `course` / `temp` / `spin` updating when the
  user changes selection on the panel.
- No regression in the three sibling washer test suites
  (`F_V__F___W.B_1QEUK`, `F_V8_Y___W.B_2QEUK`, `Y_V8_Y___W.B32QEUK`).
