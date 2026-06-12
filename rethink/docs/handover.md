# Rethink Development Handover

**Last updated:** 2026-06-12 · deployed version **1.0.64** · suite **302 tests, all green** (`npm test`, ~2.5 s)

## What this project is

A fork of [anszom/rethink](https://github.com/anszom/rethink) — a local protocol
bridge for LG ThinQ appliances. It intercepts ThinQ cloud traffic and translates
it to MQTT, so appliances work locally without the LG cloud. Runs as a Home
Assistant add-on.

| Fact              | Value                                          |
| ----------------- | ---------------------------------------------- |
| Repo              | https://github.com/kaldurhan/rethink (private) |
| Working dir (WSL) | `/home/zorgin/project/rethink/rethink`         |
| HA add-on slug    | `rethink` (store slug `daf7d2b6_rethink`)      |
| GHCR image        | `ghcr.io/kaldurhan/rethink`                    |

**Policy: local-only.** No sensors are sourced from the LG cloud feed. The cloud
MQTT stream is used strictly as a correlation reference when reverse-engineering
binary byte positions.

## Where knowledge lives

- **`docs/protocol/`** — the protocol source of truth: framing, code tables,
  suppression rules, the duplicate-Done traps, confidence-tagged per claim.
  Read this before touching a decoder.
- **This file** — project state, the open gap list, workflows.
- Root `HANDOVER.md` (git root) — retired; pointer only. Its content was either
  superseded by `docs/protocol/` or ported there (undecoded-packet appendices).
- **Captures + tooling** — `/home/zorgin/rethink-captures/` (raw ndjson, decoded
  logs, and the `.mjs` capture/monitor scripts; `monitor-validation-cycle.mjs`
  is the re-runnable cycle validator, `capture-cycle.mjs` the passive
  dual-machine recorder).
- Stage-machine + cycle_phase design specs — project repo
  `/home/zorgin/project/docs/superpowers/specs/` (2026-06-11).

## Appliances integrated

| Device                     | ThinQ model ID | File                          | Status     |
| -------------------------- | -------------- | ----------------------------- | ---------- |
| LG F4X7511TWS washer       | `VCDWL2QEUK`   | `cloud/devices/VCDWL2QEUK.ts` | ✅ in prod |
| LG RHX7009TWS tumble dryer | `SDH_X7_7008`  | `cloud/devices/RHX7009TWS.ts` | ✅ in prod |

## Architecture

- **`cloud/devices/stage_fsm.ts`** — `StageFSM` owns all `stage` transitions via
  explicit per-device tables (`WASHER_TABLE`, `DRYER_TABLE`). Devices translate
  packets into events (`cycleActive`, `rinsePhase`, `spinPhase`, `heatPhase`,
  `dryPhase`, `coolPhase`, `paused`, `ended`, `standby`, `offTimeout`).
  Guarantees exactly-once Done edges; illegal events are ignored + dedup-logged;
  Paused remembers the prior stage and restores it on resume.
- **`cloud/devices/stage_store.ts`** — stage persisted to `/data/stage-state.json`
  (test override `RETHINK_DATA_DIR`); restored on boot so a cycle ending while
  the add-on is down yields one late Done.
- **`cloud/devices/aabb_device.ts`** — AABB framing, `publishProperty` cache,
  `initStageFSM()` (persistence + publish + Done→Off 5-min fallback timer).
- **HA side** (repo `/home/zorgin/project`): `ha-automations/` —
  `tvattmaskin_refactored.yaml` / `torktumlare_refactored.yaml` (cykelhanterare,
  restart-safe START, `start_kwh > 0` FINISH guard, washer pause tracking) and
  `laundry_watchdog.yaml` (power-meter cross-check of the stage sensor).
  Imported into HA 2026-06-11.

## Validation status

Re-validation **PASSED on 1.0.63** (2026-06-12, Turbowash 39 + Quick Dry 30,
monitored live): exactly one Done edge per machine, one notification each,
watchdog silent. The 1.0.59 dryer failure sequence replayed byte-for-byte with
no duplicate Done. The two live failure modes that drove 1.0.60/1.0.61 are
documented as the "duplicate-Done traps" in the dryer spec (§6) with the real
packets as regression fixtures. 1.0.64 fixed the last cosmetic wart (post-cycle
remaining_time blip). Raw evidence: `validation-2026-06-1*-*` in the captures dir.

## Open gaps (code ↔ spec audit, 2026-06-12)

### Washer

1. ~~Door sensor known-bad~~ **RESOLVED 2026-06-12** (pending release): the
   idle door test revealed `inner[3]` is the **frame-length byte**, not a
   packet type (spec §1) — the old `0x63`/`0x4c` "door events" were 99/76-byte
   telemetry. Real door events: 65-byte info-class frames, `[12]=0x06,
[13]=0x10`, state at `[18]` (spec §4.2). Decoder re-keyed; regression
   fixtures from the live capture.
2. ~~Spin codes unmapped~~ **RESOLVED 2026-06-12** (pending release): full
   wheel cloud-correlated via spin scroll — the entire previous map was
   shifted two positions (`0x06`=1000, not 400; `0x0c`=drain-only, not 1200).
   Spec §3.4 corrected; unknown codes now keep the last value instead of
   publishing 0.
3. **Stage events still come from the `0x53` heuristic** (ramp + 90 s
   tumble-silence gate) while `cycle_phase` already derives Rinsing/Spinning
   from activity codes `0x0c`/`0x0e`, which fire **~85 s earlier** (spec §4.3).
   Candidate simplification: dispatch `rinsePhase`/`spinPhase` from activity
   codes and drop the 0x53 path; stage and cycle_phase can currently disagree
   for ~1.5 min.
4. **No explicit End-packet sub-block guard.** Spec §6.4 says End packets carry
   no valid sub-block; the code relies on the locator failing rather than
   skipping decode when `st == 0x04` (the dryer enforces the equivalent rule).
5. ~~Pause-code shape audit~~ **CLOSED 2026-06-12**: a real door-pause delivered
   0x0c in a new shape (`[12]=0x4d`) — pause code is shape-independent on the
   washer, ~23 s latency, never false (spec §4.2).
6. **`sub[15]` (initial/total time) unread** — combined with `0x8a` elapsed
   time this gives a % progress sensor. Pure code, no capture needed.
7. **Activity labels `0x03`/`0x26`/`0x02`** (Detecting/Filling/pre-wash) are
   best-guess — confirm on a programme with a weigh step (Bomull/Eco).
   'Detecting' did **not** appear at a Turbowash 39 start.
8. **Undecoded packet types** `0x67`, `0x88`, `0x8e`, `0x9e`, `0x80`, `0xa0`,
   `0x16` — inventory with known constants in washer spec §10. Most promising:
   `0x67` (per-minute sampler — correlate against cloud `remainTimeMinute`).

### Dryer

9. **No energy sensor.** The washer publishes `course_spend_power`; the dryer's
   equivalent data (info-class shape `0x75`, len 172 — historically catalogued
   as packet type `0xb0`, 79×/cycle) is undecoded. See dryer spec §10.
10. ~~`0x07` pause code~~ **CLOSED 2026-06-12**: real door pause emits 0x0c
    (same as panel pause); 0x07 dropped. Dryer door sensor implemented (gap 13b).
11. **`dryness_level` and `drying_mode` sensors decode the wrong bytes** —
    the 2026-06-12 panel scrolls showed both were reading programme
    _durations_ that co-varied with the settings (spin-map-class error). Real
    fields: dryness at `inner[14]` (1=Damp, 3=Iron, 5=VeryDry), ecoHybrid at
    `inner[15]` (2=Normal, 3=Turbo) — dryer spec §2.2. Rework needs the
    in-cycle layout question answered first (spec §8.5: these offsets hold
    the phase tuple while running).
12. **`ST=0x03` (Cooldown) dispatches `ended`, not `coolPhase`**
    (`RHX7009TWS.ts:259`). Benign in all captures (only seen at end-of-cycle),
    but the intent is unpinned — a mid-cycle Cooldown-ST packet would latch Done
    early. Add a comment or test pinning why.
13. **Total-time field found** (2026-06-12): TR during selection = programme
    duration (= cloud `initialTimeMinute`), spec §2.2. Remaining work:
    capture it at cycle start in the decoder → % progress sensor.
    13b. ~~Dryer door sensor~~ **IMPLEMENTED 2026-06-12** (pending release): door
    event `[31]` (0x01=open, polarity confirmed mid-cycle) + active-phase
    closed-inference, washer parity (spec §5).

### Cross-cutting

14. **Washer FINISH doesn't close a still-open pause** if the cycle ends while
    Paused (HA automation layer; the dryer handles this). Accuracy nit.
15. **Load level / soil / error sensors have no known binary source** (cloud has
    `loadLevel`, `soilWash`, `error` — off-limits per the local-only policy).
    Hunting them needs paired captures: light vs heavy load, same course at
    different soil settings.

## Experiment queue (captures that unblock gaps)

| Experiment                                | Duration | Unblocks  |
| ----------------------------------------- | -------- | --------- |
| Washer spin-button scroll (cloud feed on) | ~2 min   | gap 2     |
| Idle washer door open/close               | ~2 min   | gap 1     |
| Mid-cycle dryer door pause                | ~1 min   | gap 10    |
| Dryer drying-mode browse                  | ~2 min   | gap 11    |
| Any wash with a weigh step (Bomull/Eco)   | passive  | gap 7     |
| Any full cycles (both machines)           | passive  | gaps 8, 9 |
| Light vs heavy load, paired               | 2 cycles | gap 15    |

## How to add a new device

1. Create `cloud/devices/YOURDEVICE.ts` extending `AABBDevice`
2. Add `tests/cloud/devices/YOURDEVICE.test.ts` with hex captures as fixtures
3. Register in `cloud/ha_bridge.ts`: `['THINQ_MODEL_ID']: YourDevice`
4. `npm test` from `/home/zorgin/project/rethink/rethink`

Reference implementations: `VCDWL2QEUK.ts` (washer-type), `RHX7009TWS.ts`
(dryer-type). Do **not** use `--test-force-exit` — it silently truncates the
suite under load; long-lived timers are `.unref()`'d so plain `npm test` exits
promptly.

## Release / deploy workflow

1. Implement + test + commit (feature branch for non-trivial work)
2. Merge to `master`
3. Bump `rethink/homeassistant/config.yaml` `version`
4. Commit + tag `vX.Y.Z`; push master + tag
5. `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..." --target master`
   → `docker-publish.yml` builds `ghcr.io/kaldurhan/rethink:X.Y.Z` + `:latest`
   (semver pattern strips the `v`; the tag must contain the fixed workflow or
   the image gets a `v` prefix and HA 404s)
6. In HA: Settings → Add-ons → Rethink → Update
7. **After the update, restart the add-on once more.** Container replacement
   leaves the appliances holding half-open TLS sessions — they go silent for
   10–15 min (debug WS reports `status: online` but zero frames) until their
   Wi-Fi modules time out. An extra restart forces the immediate re-handshake
   (observed live 2026-06-12, 1.0.64→1.0.65). In-place restarts don't have
   this problem (~2 min recovery).

Push to `master` alone publishes the `:dev` tag.

## Repo structure

```
rethink/
├── cloud/
│   ├── devices/
│   │   ├── aabb_device.ts    # AABB base: framing, publish cache, FSM wiring
│   │   ├── stage_fsm.ts      # StageFSM + WASHER_TABLE / DRYER_TABLE
│   │   ├── stage_store.ts    # /data/stage-state.json persistence
│   │   ├── VCDWL2QEUK.ts     # LG washer (F4X7511TWS)
│   │   └── RHX7009TWS.ts     # LG dryer (SDH_X7_7008)
│   └── ha_bridge.ts          # ThinQ model ID → device class registry
├── docs/
│   ├── handover.md           # this file
│   └── protocol/             # reverse-engineered protocol specs
├── tests/cloud/devices/      # one test file per device, real packets as fixtures
├── homeassistant/config.yaml # add-on manifest (version lives here)
└── Dockerfile                # built by CI on release
```
