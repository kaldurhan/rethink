# Rethink Development Handover

## What this project is

A fork of [anszom/rethink](https://github.com/anszom/rethink) — a local protocol bridge for LG ThinQ appliances. It intercepts ThinQ cloud traffic and translates it to MQTT, so appliances work locally without the LG cloud. Runs as a Home Assistant addon.

**Repo:** https://github.com/kaldurhan/rethink  
**Working directory (WSL):** `/home/zorgin/project/rethink/rethink`  
**HA addon slug:** `rethink` (store slug `daf7d2b6_rethink`)  
**GHCR image:** `ghcr.io/kaldurhan/rethink`  
**Deployed version:** 1.0.64 (2026-06-12)

---

## Appliances integrated

| Device                     | ThinQ model ID | File                          | Status      |
| -------------------------- | -------------- | ----------------------------- | ----------- |
| LG F4X7511TWS washer       | `VCDWL2QEUK`   | `cloud/devices/VCDWL2QEUK.ts` | ✅ Complete |
| LG RHX7009TWS tumble dryer | `SDH_X7_7008`  | `cloud/devices/RHX7009TWS.ts` | ✅ Complete |

Suite: 294 tests, plain `npm test`, ~2 s.

---

## Stage state machine (built + shipped 2026-06-11, v1.0.55–1.0.59)

Spec: `/home/zorgin/project/docs/superpowers/specs/2026-06-11-laundry-state-machine-design.md`
(plan next to it in `plans/`). Goal: exactly-once Done notifications.

### Architecture

- **`cloud/devices/stage_fsm.ts`** — `StageFSM` owns ALL `stage` transitions via
  explicit per-device transition tables (`WASHER_TABLE`, `DRYER_TABLE`).
  Devices translate packets into events (`cycleActive`, `rinsePhase`,
  `spinPhase`, `heatPhase`, `dryPhase`, `coolPhase`, `paused`, `ended`,
  `standby`, `offTimeout`). Guards: Done latches (exactly one edge per cycle),
  `ended` while Off is ignored+logged, backward transitions ignored+logged
  (dedup), pause remembers the prior stage and restores it on resume.
- **`cloud/devices/stage_store.ts`** — stage persisted to
  `/data/stage-state.json` (test override: `RETHINK_DATA_DIR`); restored on
  boot, so a cycle ending while the add-on is down yields one late Done.
- **`aabb_device.ts`** — `initStageFSM(table)`: persistence + publish +
  Done→Off fallback timer centralised in the FSM onChange.
- MQTT contract unchanged: entity IDs and enum values are the same; `Paused`
  added to washer run_state/stage enums.

### Selection-state gating (the validation-day discoveries)

Both machines broadcast **ST=0xec ("Running") while a programme is merely
selected on the panel** — drum off. Three rules prevent false states:

1. **Washer:** selection status-blocks end in terminator `(01,00)` at
   `sub[20..21]`; running blocks carry drum-activity codes there. Both
   `cycleActive` and `run_state` are gated on this signature (selection is
   treated like DisplayOn: keep last meaningful state, fall back to Standby).
2. **Dryer:** selection packets carry phase tuple `0x0100` (Startup) — byte-
   identical to the first ~8 s of a real cycle. Neither Idle nor Startup
   starts the stage machine or claims Running; the first Heating/Drying packet
   does. Deliberate trade-off: dryer `run_state` lags ~8 s at a real start.
3. **Dryer info-class ST=0x03 codes** (at `inner[13]`, mirrored at
   `inner[17]`): the code's meaning is keyed by the sub-block length at
   `inner[12]`. User events arrive in short packets (`[12]=0x16`, len 77–81:
   `0x0c` panel pause, `0x10` idle door, `0x12` cooldown chime; `[12]=0x1e`,
   len 85: `0x0e` idle panel). The len=96 shape (`[12]=0x29`) carries a
   **progress counter** (walked 0x07→0x08→0x09 across a live cycle) — its
   0x07 was misread as a door-open pause code until first-cycle validation
   caught a 1-s spurious Paused mid-Drying (door untouched, user-confirmed).
   Since 1.0.61, Paused requires the user-event shape AND code 0x0c/0x07;
   0x07's true meaning awaits a real mid-cycle door-pause capture. Washer
   codes: `0x0c` pause, `0x0b` detergent input, `0x01` detecting, `0x11`
   idle-browse, `0x1e` pre-detect — the washer may need the same shape audit
   (no spurious pause observed live yet).

All of these were found live (watchdog alarm / frozen states within minutes of
deployment) and each has the actual captured packet as a regression fixture.

### Two phase fields per washer status block (important for future decoding)

`sub[1..2]` is a **display/selection code** (temp index + settled marker —
frozen at e.g. `(03,0e)` for an entire Eco 40-60 cycle), while the real drum
activity progresses at **`sub[20]`** (`sub[21]` echoes the previous code;
Eco sequence: `01→03→26→02→0b` (wash, `26↔0b` refills) `→0c→0e→10→00`).
**The cycle_phase rework landed in 1.0.63**
(spec `docs/superpowers/specs/2026-06-11-washer-cycle-phase-activity-design.md`,
project repo): `cycle_phase` decodes from `ACTIVITY_VCDWL[sub[20]]`
(Idle/Detecting/Filling/Washing/Rinsing/Spinning/Finished; `03/26/02`
labels best-guess, confirm next live cycle); passive blocks (act
`01/10/00`) replace the display-tuple Finished suppression — which had
been eating LIVE final-spin packets (disp `(00,00)` appears mid-spin),
freezing remaining_time/run_state through every spin; two mis-pick guards
(rem > 360 in the locator; course-continuity while stage active) kill the
114-byte variant's fake blocks; `lastTumbleTime` only refreshes on
tumble-class codes so the 0x53 final-spin stage gate keeps working.
Eco replay pins both walks (stage + phase). Full-cycle raw capture:
`/home/zorgin/rethink-captures/` and `tests/fixtures/eco-cycle-raw.ndjson`.

### HA side (repo `/home/zorgin/project`)

- `ha-automations/tvattmaskin_refactored.yaml` / `torktumlare_refactored.yaml`
  — cykelhanterare with restart-safe START (accepts unknown/unavailable from-
  states, blocks resumes), guarded FINISH (`start_kwh > 0`), washer pause-
  duration tracking. `laundry_watchdog.yaml` — power-meter cross-check
  (>10 W 5 min while stage Off = missed start; <4 W 15 min while active =
  missed end; Paused excluded). Imported into HA 2026-06-11.
- Dashboard (ha-dashboard repo): washer `displayStates` gained `Paused`
  (deployed v1.157). `yaml-check.sh` now handles multi-document files.

### Validation status

- ✅ Idle interactions (door/panel/power on both machines) end at
  run_state=Standby, stage=Off — user-verified on 1.0.59.
- ✅ First real wash on the new stack (Quick 14, 2026-06-11 18:40): exactly one
  Done edge, Done→Off fallback after 5 min, one notification, watchdog silent.
- ❌→fixed: first real dry (Quick Dry 30, 2026-06-11 18:51) produced a
  **duplicate Done edge** on 1.0.59: 5 s after AntiCrease latched Done, a
  double-block ST=0xec packet with sub2 TR=1 (so the TR=0 post-cycle guard
  missed it) and unmapped phase tuple `(04,00)` passed the blocklist
  cycleActive gate and restarted the FSM (Done→Heating); the End packet 21 s
  later latched Done #2. The HA `start_kwh > 0` FINISH guard suppressed the
  double notification (defense in depth worked). Fixed in 1.0.60: ST=0xec
  with an unmapped phase tuple is treated like selection chatter (no
  run_state claim, no FSM events, no remaining_time); both packets are
  regression fixtures. Monitor log + raw captures:
  `/home/zorgin/rethink-captures/validation-2026-06-11-*`.
- ❌→fixed: during the same dry, a 1-s spurious Paused blip at 18:41:57
  (door untouched, user-confirmed) — the len=96 info-packet progress counter
  reading 0x07 collided with the pause code set. Fixed in 1.0.61: pause
  codes are gated on the user-event packet shape (`inner[12]=0x16`); see
  selection-gating rule 3 above.
- ✅ **Re-validation PASSED on 1.0.63** (2026-06-12 06:32–07:22, Turbowash 39
    - Quick Dry 30, monitored live): exactly one Done edge per machine, one
      notification each, watchdog silent. Dryer: the 1.0.59 failure sequence
      replayed byte-for-byte (AntiCrease → unknown `(4 0)` tumble → End) with no
      duplicate Done and no Paused blip; program kept "Quick Dry 30" at End.
      Washer: cycle_phase walked Washing→Filling↔Washing→Rinsing→Spinning→
      Finished; remaining_time live through the entire final spin (9→…→0 — was
      frozen at 3 on the old decoder); no course flicker. Activity code 0x0e
      flagged Spinning 85 s before the 0x53 stage heuristic — candidate for a
      future stage-event simplification. Note: 'Detecting' (0x03) did not appear
      at Turbowash start — label still unconfirmed. One cosmetic wart found and
      fixed in 1.0.64: post-cycle tumble block (act 0x10, rem=1) blipped
      remaining_time 0→1 after End; passive post-cycle blocks no longer publish
      remaining_time. Monitor tooling re-runnable:
      `/home/zorgin/rethink-captures/monitor-validation-cycle.mjs`.

### Open follow-ups

- ~~cycle_phase rework using activity codes~~ DONE in 1.0.63 (see "Two phase
  fields" section above). Remaining nit: confirm the best-guess
  Detecting/Filling labels (act 03/26/02) against the next live wash start.
- Washer door sensor false-open: a 0x63-byte-long info packet collides with
  the `packetType === 0x63` door intercept; real door events may be the short
  `aa 08 20 …` frames (currently discarded as <11 bytes). Needs an idle
  door-open capture of the WASHER.
- Washer FINISH doesn't subtract a still-open pause if the cycle ends while
  Paused (dryer handles this; washer accuracy nit).
- ~~Dryer course 0x21 name~~ RESOLVED 2026-06-11: full programme-knob scrolls
  on both machines, cloud-correlated live (capture
  `program-scroll-2026-06-11-*` in `/home/zorgin/rethink-captures/`). All
  15 washer + 13 dryer panel courses byte-validated; washer gained
  0x37 Sköljning+Centrifugering / 0x4e Centrifugering; the dryer table had
  4 wrong + 5 phantom entries (fixed in 1.0.62) and 0x21 turned out not to
  be a course at all — End packets no longer update `program`.
- drying_mode fixtures still synthetic (no real mode-browse capture).
- Capture a real mid-cycle dryer door-open pause to learn its actual code
  (0x07 in the pause set is currently an unverified guess, shape-gated).
- Audit the washer's info-class pause gate for the same shape-dependence
  (`inner[12]` sub-block length) found on the dryer.

---

## RHX7009TWS — what was implemented (2026-06-03)

### HA entities published

| Property         | Type         | Notes                                                       |
| ---------------- | ------------ | ----------------------------------------------------------- |
| `run_state`      | sensor       | Standby / DisplayOn / Running / Cooldown / AntiCrease / End |
| `program`        | sensor       | Course name (Mixed Fabrics, Cotton, Quick Dry 30, etc.)     |
| `phase`          | sensor       | Idle / Heating / Drying / Cooldown                          |
| `dryness_level`  | sensor       | Iron Dry / Cupboard Dry / Extra Dry (shown when idle)       |
| `drying_mode`    | sensor       | Efficiency / Turbo (shown when idle, phase ≠ Idle)          |
| `remaining_time` | sensor (min) | Countdown while running; 0 on End/AntiCrease                |

### Protocol — CORRECTED byte offsets

The `processAABB(inner)` method receives the AABB packet with `aa ff` header and `checksum bb` trailer stripped.

**Critical: these differ from the upstream RH90V9_WW spec — verified against actual captures.**

| Byte   | Field                  | Notes                                   |
| ------ | ---------------------- | --------------------------------------- |
| `[0]`  | Frame type             | Must equal `0x30` — return early if not |
| `[10]` | ST — machine state     | NOT `[8]` as in RH90V9_WW               |
| `[14]` | Phase byte A           |                                         |
| `[15]` | Phase byte B           |                                         |
| `[18]` | CS — course code       | Single byte, NOT LE uint16 at [16..17]  |
| `[23]` | TR — time/dryness/mode | Single byte, NOT LE uint16 at [22..23]  |

**Guards:**

- `inner.length < 11` → return (can't read ST)
- `inner.length < 24` → publish `run_state` only (standby short packet)
- `inner[0] !== 0x30` → return (not our frame type)
- `inner[8] === 0x02` → info-class packet (different layout, phase at [13..14])
- `inner.length >= 116` → double-block packet (authoritative state in second sub-block)

**ST values:**

- `0x0b` = Standby, `0xeb` = DisplayOn, `0xec` = Running
- `0x03` = Cooldown, `0xe2` = AntiCrease, `0x04` = End

**TR context:**

- ST=`0xec` (running): TR = minutes remaining
- ST=`0xeb`, phase byte A = `0x05`: TR = dryness level
- ST=`0xeb`, phase byte A ≠ `0x05`: TR = drying mode

**Phase tuple `[A, B]`** (full table in `PHASES`, `cloud/devices/RHX7009TWS.ts`):

- `[05, 03]` = Idle, `[01, 00]` = Startup, `[03, 09]`/`[03, 07]` = Heating,
  `[07, 01]`/`[07, 03]` = Drying, `[07, 10]`/`[07, 11]` = Cooldown,
  `[11, 00]`/`[08, 11]` = Finishing

### Known gaps (accepted tech debt)

- Course `0x21` labelled 'Auto Dry' — observed only in End packets, exact name unconfirmed
  (check the panel during a live run)
- `drying_mode` branch (ST=`0xeb`, phA≠`0x05`) is covered only by **synthetic** fixtures
  (DISPLAY_ON_IDLE with phA/TR mutated) — no real capture of mode-browsing exists yet;
  replace fixtures when one is taken
- Long-lived timers (`scheduleOff`, filter-probe timeouts) are `.unref()`'d; plain
  `npm test` exits promptly (~1-2s). Do **not** use `--test-force-exit` — it silently
  truncates the suite under load (observed: 241–281 tests reported across identical runs)

---

## How to add a new device

1. Create `cloud/devices/YOURDEVICE.ts` extending `AABBDevice`
2. Add test file `tests/cloud/devices/YOURDEVICE.test.ts` with hex captures
3. Register in `cloud/ha_bridge.ts`: `['THINQ_MODEL_ID']: YourDevice`
4. Run `npm test` from `/tmp/rethink/rethink`

Use `cloud/devices/RHX7009TWS.ts` as the reference for AABB dryer-type devices.  
Use `cloud/devices/VCDWL2QEUK.ts` as the reference for washer-type devices.

---

## Development workflow

```bash
# Run tests
cd /home/zorgin/project/rethink/rethink && npm test

# Run only one device's tests
npm test 2>&1 | grep -A2 "RHX7009TWS"
```

---

## Release / deploy workflow

1. Implement + test + commit to `feat/add-DEVICENAME` branch
2. Merge to `master`: `git checkout master && git merge feat/add-DEVICENAME`
3. Bump version in `rethink/homeassistant/config.yaml`: `version: '1.x.0'`
4. Commit + tag: `git commit -m "chore: bump version to 1.x.0" && git tag v1.x.0`
5. Push: `git push origin master && git push origin v1.x.0`
6. Create GitHub Release: `gh release create v1.x.0 --title "v1.x.0" --notes "..." --target master`
    - This triggers `docker-publish.yml` → builds + pushes `ghcr.io/kaldurhan/rethink:1.x.0`
7. In HA: Settings → Add-ons → Rethink → Update (or three-dot → Rebuild)

**Important:** The git tag must point to the latest master commit (which contains the fixed `docker-publish.yml`). If the tag predates the workflow fix, the image will be pushed as `v1.x.0` (with `v` prefix) instead of `1.x.0`, and HA will 404.

---

## CI/CD

**File:** `.github/workflows/docker-publish.yml`  
**Triggers:**

- Push to `master` → publishes `ghcr.io/kaldurhan/rethink:dev`
- GitHub Release published → publishes `ghcr.io/kaldurhan/rethink:{version}` + `:latest`

Uses `type=semver,pattern={{version}}` to strip the `v` prefix from the git tag so the image tag matches the `version` field in `config.yaml`.

---

## Repo structure

```
rethink/
├── cloud/
│   ├── devices/          # One file per appliance
│   │   ├── aabb_device.ts    # Base class for AABB-protocol devices
│   │   ├── RHX7009TWS.ts     # LG tumble dryer (SDH_X7_7008)
│   │   └── VCDWL2QEUK.ts    # LG washer (F4X7511TWS)
│   └── ha_bridge.ts      # Device registry (maps ThinQ model ID → class)
├── tests/
│   └── cloud/devices/    # One test file per device
├── homeassistant/
│   └── config.yaml       # HA addon manifest (version lives here)
└── Dockerfile            # Built by CI on release
```
