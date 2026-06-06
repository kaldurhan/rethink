# Rethink — Session Handover

## Project

**rethink** is a Home Assistant add-on that acts as a local protocol translator for LG ThinQ appliances. It intercepts the device's ThinQ2 cloud connection and bridges it to local MQTT, eliminating the LG cloud dependency after initial setup.

- Repo: `kaldurhan/rethink` (private), branch `master`
- Working dir: `/tmp/rethink/rethink`
- Container image: `ghcr.io/kaldurhan/rethink`
- Current released version: **1.0.36**
- Build: `npm run build` (tsc + tsc-alias + cp html → dist)
- Release: `gh release create vX.Y.Z` triggers the GHCR publish workflow

---

## Active Device

**LG F4X7511TWS** — washer-dryer combo  
Device file: `cloud/devices/VCDWL2QEUK.ts`  
Extends `AABBDevice` → `processAABB(inner: Buffer)` is the entry point for all binary packets.

---

## Binary Protocol (AABB)

All local device packets have the form:

```
AA [byte2] [inner...] [checksum] BB
```

`processAABB` receives `inner = buf.subarray(2, buf.length-2)`.

Long status packets have `byte2 = 0xff` and `inner[0] = 0x20`.  
Short keepalives (`byte2 = 0x07`, inner < 11 bytes) are dropped silently.  
The guard at top of processAABB: `if (inner.length < 11 || inner[0] !== 0x20) return`

### Key byte positions in long packets

| Position    | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `inner[3]`  | Packet type                                          |
| `inner[6]`  | Monotonic sequence counter (shared across all types) |
| `inner[10]` | State byte (mapped via `STATES_VCDWL`)               |

---

## Packet Types

| Type   | inner[10]          | Description                                                                   |
| ------ | ------------------ | ----------------------------------------------------------------------------- |
| `0x13` | `0x0b` (Standby)   | Short Standby status — no sub-block                                           |
| `0x44` | `0xeb` (DisplayOn) | Full status — user browsing panel                                             |
| `0x76` | `0xec` (Running)   | Full status — cycle active (two sub-blocks)                                   |
| `0x17` | `0x4d`             | Device→broker: course list query (discarded)                                  |
| `0x30` | `0x4d`             | Device→broker: PANEL_COURSE_LIST report (discarded)                           |
| `0x41` | `0x03`             | Capability dump — fires on power-on and periodically (discarded)              |
| `0x63` | `0x03`             | **Door OPEN event** — intercept before state check                            |
| `0x4c` | `0x03`             | **Door CLOSE event** — intercept before state check                           |
| `0x8a` | `0x02`             | **Periodic snapshot** — intercept before state check (see below)              |
| `0x53` | `0x03`             | **Motor ramp** — intercept before state check; SpinRamp when 0x76 silent >90s |
| `0x16` | `0x4d`             | Init packet (post-TCLCount=2) — purpose unclear, discarded                    |
| `0x83` | —                  | Firmware version strings (never observed in processAABB)                      |
| any    | `0x04`             | End state                                                                     |
| any    | `0xe2`             | AntiCrease state                                                              |

`0x03` and `0x4d` are not in `STATES_VCDWL` — packets with these state bytes are normally discarded. The door packets (`0x63`, `0x4c`) and periodic packets (`0x8a`, `0x53`) are intercepted on `inner[3]` BEFORE the state check.

Every packet type is retransmitted 3× by the device. The broker ACKs some (0x17) but not others (0x41, 0x63, 0x4c).

### Newly discovered packet types (2026-06-06, Blandmaterial captures)

Deep byte analysis from three captures: partial cycle (10:29), near-full cycle (13:33–14:56, ~83 min), end-of-cycle (15:04–15:40).

| Type   | ST     | Inner len | Status                                                              |
| ------ | ------ | --------- | ------------------------------------------------------------------- |
| `0x53` | `0x03` | 79        | **IMPLEMENTED** — motor ramp; drives SpinRamp when 0x76 silent >90s |
| `0x67` | `0x03` | 99        | Partially decoded (per-minute rinse sampler)                        |
| `0x80` | `0x03` | —         | Appears once at end-of-cycle (~15:37); purpose unknown, discarded   |
| `0x88` | `0x03` | 132       | Partially decoded (rinse-cycle event); 4th burst seen at 15:26      |
| `0x8a` | `0x02` | 134       | **IMPLEMENTED** — elapsed_time, phase_remaining_time, water_temp    |
| `0x8e` | `0x03` | 138       | Confirmed: pure transition marker (discarded)                       |
| `0x9e` | `0x03` | 154       | Undecodable without more captures                                   |
| `0xa0` | `0x03` | —         | Appears once at end-of-cycle (~15:38); purpose unknown, discarded   |

#### 0x53 — Motor ramp packet (IMPLEMENTED in v1.0.35)

Fires every ~6 seconds whenever the drum motor is running. Always `ST=0x03`.

- `inner[12]=0x18` — constant (motor-controller active marker)
- `inner[13]` — speed step in range `0x12..0x1f`; `inner[17]` mirrors it
- `inner[24]` — elapsed minutes (roughly matches `0x8a inner[23]`)
- `inner[25+]` — all zeros during gentle tumble; motor speed data during final spin

**Key finding**: 0x53 fires both during gentle tumble (concurrent with 0x76) AND during the final drain+spin (exclusive, no 0x76 for 15+ min). A `lastTumbleTime` field gates the publish: SpinRamp is only published when the last 0x76 sub-block was >90s ago. This correctly identifies the final spin phase while suppressing false positives during tumble ramp-up.

**Phase gap pattern**: 0x76 and 0x53 both stop during inter-tumble drain/fill phases (~15 min gaps). Then 0x53 resumes first (immediately at spin ramp-up), followed by 0x76 Tumble 1–3 min later.

**SpinActive** (`0x080e`, `0x0a0e`) was never observed in `0x76` sub-blocks in any capture — those codes may not apply to this device. The 0x53 path covers all spin detection.

#### 0x8a — Periodic snapshot (IMPLEMENTED in v1.0.34)

Only packet type with `ST=0x02`. Fires every 5 min (3 retransmits per fire). `inner[12]=0x4f` constant.

| Byte            | Encoding                                                                                                                            | Confidence                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `[23]`          | **Elapsed minutes since door-lock.** Perfectly monotonic +5 per 5-min window. Confirmed 50→130 over 83-min capture.                 | High                        |
| `[25]`          | **Phase remaining time (min).** Counts down during phase; resets on wash→rinse transition (0→55). Confirmed from multiple captures. | High                        |
| `[31..35]`      | **Water/drum temperature (°C).** 5 sensor points, 36–49°C during rinse. inner[31] published as `water_temp`.                        | High                        |
| `[30]` / `[20]` | 0x8a internal counters                                                                                                              | Confirmed but not published |

Published sensors: `elapsed_time` (inner[23]), `phase_remaining_time` (inner[25]), `water_temp` (inner[31]).

#### 0x88 — Rinse cycle event sentinel

Fires in bursts of 3, exactly 3× per full cycle (confirmed from 83-min capture):

| Firing  | Time          | context                            |
| ------- | ------------- | ---------------------------------- |
| Burst 1 | ~cycle min 4  | First rinse start                  |
| Burst 2 | ~cycle min 37 | Second rinse start                 |
| Burst 3 | ~cycle min 55 | Third rinse start (or final rinse) |

`inner[13]=0x06` constant across all firings in both captures. The byte at ~`inner[21]` tracks elapsed minutes (matches `0x8a inner[23]`). Inner bytes [14..20] vary per firing — likely rinse-cycle counter or energy accumulator. Load level still not decodable from `0x88` alone.

#### 0x8e — Wash→rinse transition marker

Single unique sequence (3 retransmits). All bytes constant. Fires 8 seconds before cloud sees `state=RINSING`. No variable data — the packet type itself is the signal.

Const header: `inner[12]=0x53, inner[13]=0x04, inner[14]=0x0e`.

#### 0x76 — Full status (cycle active)

**Sub-block phase decode — confirmed across three captures (10:29, 13:33–14:56, 15:04–15:40):**

- Phase `0x0010` (Tumble): observed throughout wash cycle (83-min capture), rem 60→22 min
- 0x76 pauses during final drain+spin (~22 min gap); 0x53 covers spin detection in this window
- Phase `0x0e0c` (RinseDrain): CONFIRMED at 15:26:33–15:37 in end-of-cycle capture, rem 12→1 min
- Phase `0x100e` (Finished): CONFIRMED at 15:38:22–24 — appears as rinse-drain→end transition; then anti-crease Tumble resumes
- `sub[4]` (course) = `0x2b` (Blandmaterial) throughout
- `sub[3]` (spin) = `0x06` (400 RPM) during tumble; varies during drain (0x27 observed)
- WashTumble (0x0b10), RinseFill (0x040e), RinseTumble (0x060e), SpinActive (0x080e/0x0a0e) — not yet observed in any capture

#### 0x67 — Per-minute rinse sampler

Fires ~60s intervals during and after rinsing. `inner[12]=0x2c, inner[13]=0x07` constant. Data bytes vary; correlate against cloud `remainTimeMinute` in next capture.

#### 0x9e — Large periodic packet (every ~10 min)

40 packets, inner_len=154. `inner[12]=0x63, inner[13]=0x0f` constant. Purpose unknown.

---

## Status Sub-Block

The `findStatusSubBlock(inner)` function scans backwards for a 21-byte sub-block.

Two variants:

- `0x05`-variant: DisplayOn / Idle / spin phases → terminator `sub[20] = 0x01`
- `0x03`-variant: Running (wash/rinse/spin) → terminator `sub[20] = 0x0b`

Sub-block layout (positions relative to sub-block start):

| Offset | Content                                         |
| ------ | ----------------------------------------------- |
| `[0]`  | Marker (0x05 or 0x03)                           |
| `[1]`  | phA (phase byte A)                              |
| `[2]`  | phB (phase byte B)                              |
| `[3]`  | spin code                                       |
| `[4]`  | course code (cs)                                |
| `[5]`  | 0x00 anchor                                     |
| `[13]` | remaining_time_lo (or temp when Idle)           |
| `[14]` | remaining_time_hi                               |
| `[15]` | initial_time_lo                                 |
| `[19]` | course code repeated (anchor for scanner)       |
| `[20]` | terminator (0x01 = temp-scroll, 0x0b = running) |

**Temp is only published** when `subMarker === 0x05 && sub[20] === 0x01 && phase === 'Idle'`.  
Otherwise `sub[13..14]` is remaining time (LE u16, minutes).

Running packets (`0x76`) contain **two sub-blocks**: previous program + current program. Scanner picks the last one correctly.

**Suppression rule** (v1.0.36): if `inner[10] === 0xec` (Running) and `decodePhase(sub[1], sub[2]) === 'Finished'` → suppress so End/AntiCrease stays visible in HA. Covers both 0x0000 (anti-crease tumble) and 0x100e (rinse→end transition, confirmed from end-of-cycle capture).

---

## Energy Block (`10 08`)

Present in Running packets only. `findPowerBlock(inner)` scans for last `10 08` marker.

| Offset from block start | Content                         |
| ----------------------- | ------------------------------- |
| `[0..1]`                | `10 08` marker                  |
| `[2]`                   | course code                     |
| `[11..12]`              | remaining time LE u16 (minutes) |
| `[14..15]`              | courseSpendPower BE u16 (Wh)    |

---

## Phase Decoding

`decodePhase(phA, phB)`:

- If `phA === 0x18 && phB in [0x12..0x1f]` → `SpinRamp`
- Otherwise lookup `PHASES_VCDWL[(phA << 8) | phB]`

Full phase table:

| Code                                | Phase                |
| ----------------------------------- | -------------------- |
| `0x0000`                            | Finished             |
| `0x0310 / 0x0510 / 0x0810`          | Idle                 |
| `0x0110`                            | WashFill             |
| `0x0b10`                            | WashTumble           |
| `0x260b / 0x0b26`                   | WashDrain            |
| `0x0010`                            | Tumble               |
| `0x0006`                            | Drain                |
| `0x040e`                            | RinseFill            |
| `0x060e`                            | RinseTumble          |
| `0x0e0c / 0x0c0e`                   | RinseDrain           |
| `0x080e / 0x0a0e`                   | SpinActive           |
| `0x100e`                            | Finished             |
| `0x010e / 0x020e / 0x030e / 0x050e` | Idle (user browsing) |
| `0x18, phB 0x12..0x1f`              | SpinRamp             |

---

## Sensors Implemented

| HA entity              | Platform            | Source                 | States / unit                                                                                                                     |
| ---------------------- | ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `run_state`            | sensor, enum        | `inner[10]`            | Standby, Running, End, AntiCrease                                                                                                 |
| `cycle_phase`          | sensor, enum        | `sub[1..2]`            | Idle, WashFill, WashTumble, WashDrain, Tumble, Drain, RinseFill, RinseTumble, RinseDrain, SpinRamp, SpinActive, Finished, unknown |
| `course`               | sensor, enum        | `sub[4]`               | 13 Swedish programme names + unknown                                                                                              |
| `temp`                 | sensor, enum        | `sub[13]` (Idle only)  | Cold, 20-30, 40, 60, unknown                                                                                                      |
| `spin`                 | sensor, measurement | `sub[3]`               | 0 / 400 / 800 / 1000 / 1200 / 1400 rpm                                                                                            |
| `remaining_time`       | sensor, measurement | `sub[13..14]`          | minutes                                                                                                                           |
| `course_spend_power`   | sensor, measurement | `10 08` block +14..+15 | Wh                                                                                                                                |
| `door`                 | binary_sensor       | `inner[3]`             | open (0x63) / closed (0x4c)                                                                                                       |
| `water_temp`           | sensor, measurement | `0x8a inner[31]`       | °C (v1.0.34)                                                                                                                      |
| `elapsed_time`         | sensor, measurement | `0x8a inner[23]`       | minutes since door-lock (v1.0.34)                                                                                                 |
| `phase_remaining_time` | sensor, measurement | `0x8a inner[25]`       | minutes remaining in current phase (v1.0.34)                                                                                      |

---

## DisplayOn Handling

`0xeb` (DisplayOn) is suppressed: the run_state sensor is NOT updated.  
Exception: if the cached value is absent or is `'DisplayOn'` (stale retained message), publish `Standby` to correct the broker.

---

## Pending / Unknown

1. **SpinRamp false-positive window** — at the start of each new tumble phase (after a 15-min drain/fill gap), `0x53` fires ~90s before the next `0x76`, so `cycle_phase` briefly shows `SpinRamp` before `0x76` overrides it to `Tumble`. This happens for each inter-rinse break (~3 occurrences per wash). Acceptable limitation; no workaround without a full state machine.

2. **SpinActive never observed** — codes `0x080e`, `0x0a0e` not seen in any `0x76` sub-block across two captures. May not apply to this device; or may appear in a short window not yet captured. `0x53` covers all practical spin detection.

3. **End-of-cycle window confirmed** (15:04–15:40 capture, 2026-06-06). Findings:
   - Final spin: 0x53 motor-ramp packets (0x12→0x1d steps) from ~15:12, first 0x76 Tumble resumes at 15:15
   - RinseDrain (0x0e0c) in 0x76 confirmed 15:26–15:37, rem counts 12→1 min
   - Finished (0x100e) in 0x76 confirmed 15:38:22–24 (rinse→end transition)
   - End state (ST=0x04) in 0x58 packet confirmed 15:38:02–06
   - AntiCrease (ST=0xe2) in 0x44 packet confirmed 15:38:08–14
   - Post-End anti-crease: 0x76 Tumble resumes at 15:38:34+ (ST during anti-crease not confirmed — may be 0xec or 0xe2)
   - New types 0x80 (15:37:56) and 0xa0 (15:38:16) appear at end; both ST=0x03 → silently discarded
   - **Bug fixed (v1.0.36)**: suppress rule extended to phase-based check, covering both 0x0000 and 0x100e

4. **Load level from binary** — `0x88` fires at each rinse start (3×/cycle), not at DETECTING. inner[13]=0x06 constant in both captures; no load-level byte identified. Need light vs heavy wash captures side-by-side.

5. **`soilWash` from binary** — not visible in `0x8a`. May require comparing packets at the same timestamp across different soil-level cycles.

6. **Initial cycle time** — binary `sub[15]` = `initialTimeMinute` (not yet published). Could give % progress with `0x8a inner[23]` elapsed time.

7. **Error sensor** — cloud `error: "ERROR_NO"`. No binary equivalent confirmed.

8. **`0x16` packet** — appears once per session after TCLCount=2. 18 inner bytes. Purpose unknown.

9. **`0x67` decode** — per-minute rinse/spin sampler, `inner[12]=0x2c, inner[13]=0x07` constant. Correlate variable bytes against cloud `remainTimeMinute` in next capture.

10. **`0x9e` decode** — large periodic (every ~10min), `inner[12]=0x63, inner[13]=0x0f` constant. Purpose unknown.

11. **`0x53` motor data at [24+]** — during final spin, `inner[25+]` contains non-zero speed/torque data (zeros during gentle tumble at step 0x12; populated at steps 0x13..0x18). Units unknown. Could expose instantaneous spin RPM if decoded.

---

## Cloud Feed

The management server connects to LG's real AWS IoT MQTT broker using a generated RSA key + LG-signed certificate. Messages arrive as:

```json
{
  "data": { "state": { "reported": { "washerDryer": { ... } } } },
  "deviceId": "cd3637ce-6cb4-13f3-b9b5-d48d26f215f6",
  "type": "monitoring"
}
```

**Device IDs on this account:**

- `cd3637ce-6cb4-13f3-b9b5-d48d26f215f6` — the washer (VCDWL2QEUK)
- `4bfae520-1900-111b-9b77-4427458d3aac` — the dryer (RHX7009TWS); confirmed active — sends ospStandBy pings AND full DRYING state with courseSpendPower/remainTimeMinute/periodicEnergyData during a drying cycle

Cloud message types seen:

- `ospStandBy` pings (every 2s from both devices — filtered)
- `TCLCount: 0` — device powered on
- `TCLCount: 2` — LG cloud connected
- `PANEL_COURSE_LIST` + `panelCrsList` — 13 programmes (filtered, same as binary 0x30)
- `MY_COURE_LIST: "1"`, `downCrsList: []` — always empty (filtered)
- `dnn_*` weather/AI fields (filtered)
- `fwUpgradeInfo` (filtered)
- Full state dump (~40 useful fields after cleaning) — fires once per power-on after TCLCount=2
- Delta updates: individual field changes during cycle

### Cloud `state` machine (confirmed 2026-06-06)

`state` field progression during a normal wash cycle:

```
INITIAL → DETECTING → DETERGENT_INPUT → RUNNING → RINSING → SPINNING → END
```

(Full progression confirmed from cloud feed and binary captures 2026-06-06.)

### Cloud fields of interest (not yet published to HA)

| Field                   | Sample values                                | Notes                                                                                                                       |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `loadLevel`             | `LOAD_LEVEL_1..LOAD_LEVEL_9`                 | Fires ~1 min after door lock. Strip prefix → publish as sensor (1–9).                                                       |
| `soilWash`              | `SOILWASH_HEAVY/LIGHT/NORMAL`, `NO_SOILWASH` | Auto-detected soil level, updates during wash. Strip prefix.                                                                |
| `turboWash`             | `TURBOWASH_ON/OFF`                           | Whether TurboWash is active for the cycle. Boolean sensor.                                                                  |
| `periodicEnergyData`    | `{"sequenceNum":1,"power":235}`              | Per-interval Wh. seq1=235, seq2=307, seq3=18, seq4=21 Wh (heating dominates).                                               |
| `accumulatedEnergyData` | `{"sequenceNum":4,"power":581}`              | Running total Wh from cloud. Cross-reference with binary `courseSpendPower`.                                                |
| `remainTimeMinute`      | integer                                      | Cloud mirrors the binary remaining time — binary source preferred (lower latency).                                          |
| `initialTimeMinute`     | integer                                      | Total programmed cycle duration. Available from cloud at cycle start. Binary sub[15] is the same value (not yet published). |

---

## Monitor UI

URL: `http://[HOST]:44401/monitor?id=[DEVICE_ID]`

Two panels:

- **Left — Device MQTT**: binary hex packets. Retransmits collapsed to `×N` badge. Click any message to populate inject field.
- **Right — LG Cloud MQTT**: JSON notifications. "Filter noise" toggle (default ON) suppresses ospStandBy pings, dnn\_ messages, course lists, fwUpgradeInfo, and strips ~20 static config fields from the full dump.

To capture logs for analysis: open monitor page, start the action (power on / run cycle / open door), stop, copy both panels and paste together with timestamps visible.

---

## Build & Release Workflow

```bash
# In /tmp/rethink/rethink
npm run build

# Bump version in homeassistant/config.yaml
# Commit from git root (/tmp/rethink)
git add -u rethink/...files... && git commit -m "..."
git push

# Create release (triggers versioned GHCR build)
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

The workflow builds `linux/amd64`, `linux/arm64`, `linux/arm/v7`.  
Tags: `vX.Y.Z` + `latest` on release; `dev` on every master push.

---

## Key Files

| File                           | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `cloud/devices/VCDWL2QEUK.ts`  | Main device decoder — all binary packet handling              |
| `cloud/devices/aabb_device.ts` | Base class: AABB framing, publishProperty, getProperty        |
| `html/monitor.js`              | Monitor UI logic — binary dedup, cloud filter, cleanPayload   |
| `html/monitor.html`            | Monitor UI layout                                             |
| `management/index.ts`          | WebSocket server, cloud MQTT connection, device event routing |
| `util/lgcloud/monitor.ts`      | LG cloud MQTT client (RSA key gen, cert, AWS IoT connect)     |
| `homeassistant/config.yaml`    | Add-on manifest (version, ports, schema)                      |
