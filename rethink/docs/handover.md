# Rethink Development Handover

## What this project is

A fork of [anszom/rethink](https://github.com/anszom/rethink) — a local protocol bridge for LG ThinQ appliances. It intercepts ThinQ cloud traffic and translates it to MQTT, so appliances work locally without the LG cloud. Runs as a Home Assistant addon.

**Repo:** https://github.com/kaldurhan/rethink  
**Working directory (WSL):** `/tmp/rethink/rethink`  
**HA addon slug:** `rethink`  
**GHCR image:** `ghcr.io/kaldurhan/rethink`

---

## Appliances integrated

| Device                     | ThinQ model ID | File                          | Status                 |
| -------------------------- | -------------- | ----------------------------- | ---------------------- |
| LG F4X7511TWS washer       | `VCDWL2QEUK`   | `cloud/devices/VCDWL2QEUK.ts` | ✅ Complete, 202 tests |
| LG RHX7009TWS tumble dryer | `SDH_X7_7008`  | `cloud/devices/RHX7009TWS.ts` | ✅ Complete, 15 tests  |

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
- `npm test` waits out 5-minute `scheduleOff` timers before exiting (CI runs ~5m37s);
  pass `--test-force-exit` for fast local runs

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
cd /tmp/rethink/rethink && npm test

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
