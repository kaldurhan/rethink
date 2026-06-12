# LG RHX7009TWS Heat-Pump Dryer (`SDH_X7_7008`) — AABB Protocol Spec

Frame envelope and confidence-tag legend: see [README.md](README.md).
All offsets are inside `inner` (envelope stripped). Dryer frames have
`inner[0] = 0x30`.

> ⚠ These offsets were verified against live captures and **differ from the
> older RH90V9_WW community spec** (ST is at `[10]`, not `[8]`; CS and TR
> are single bytes, not LE u16). Do not copy that spec for this model.

---

## 1. Packet classification

Process in this order:

1. `inner[0] != 0x30` → ignore (telemetry/noise frames like `0x31` appear).
2. `inner.length < 11` → ignore (cannot read machine state).
3. `inner[8] == 0x02` → **info-class packet**, different layout — see §5.
   Only the machine-state byte is at the same place; CS/TR/phase offsets do
   not apply.
4. `inner.length < 24` → short status packet: machine state only.
   Short `0xec` packets only occur mid-cycle. [confirmed]
5. `inner.length >= 116` → **double-block packet** — see §3.
6. otherwise → single-block status packet — see §2.

## 2. Single-block status packets

| offset          | field                       | notes           |
| --------------- | --------------------------- | --------------- |
| `inner[10]`     | ST — machine state          | see table below |
| `inner[14..15]` | phase tuple `(phA, phB)`    | see §4.2        |
| `inner[18]`     | CS — course code            | see §4.1        |
| `inner[23]`     | TR — context-dependent byte | see §2.2        |

### 2.1 Machine state (ST) values [confirmed]

| value  | state                                                                |
| ------ | -------------------------------------------------------------------- |
| `0x0b` | Standby                                                              |
| `0xeb` | DisplayOn (panel awake; TR carries dryness/mode, §2.2)               |
| `0xec` | Running — **also broadcast during selection and post-cycle**, see §6 |
| `0x03` | Cooldown                                                             |
| `0xe2` | AntiCrease (post-end)                                                |
| `0x04` | End                                                                  |

Unknown ST values (e.g. `0x4d` telemetry bursts) must be suppressed.

### 2.2 TR byte semantics (context-dependent) [confirmed]

| context                   | TR meaning                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ST = `0xec` (running)     | minutes remaining                                                                                                                   |
| ST = `0xeb`, phA = `0x05` | dryness level: `0x1e` Iron Dry, `0x41` Cupboard Dry, `0x46` Extra Dry                                                               |
| ST = `0xeb`, phA ≠ `0x05` | drying mode: `0x46` Efficiency, `0x96` Turbo — ⚠ [best-guess: only synthetic test coverage; no real mode-browse capture exists yet] |
| ST = `0x04` / `0xe2`      | not meaningful — force remaining-time to 0                                                                                          |

**Running with TR = 0** is the post-cycle anti-wrinkle tumble — but do not
rely on this alone; one live tumble packet carried **TR = 1** and defeated a
TR=0-only guard (see §6.2). [confirmed]

## 3. Double-block packets (`inner.length >= 116`)

Carry two sub-blocks; the **second is authoritative**. The second sub-block
is always 52 bytes, but the first varies (64 or 65 bytes), so locate the
second dynamically by scanning for the first block's footer signature:

```
for i in 54..66:
    if inner[i] == 0x64 and inner[i+2] == 0x04 and inner[i+4] == 0x78:
        sub2 = i + 8
        break
```

Field offsets relative to `sub2`:

| offset        | field                    |
| ------------- | ------------------------ |
| `sub2+5`      | CS — course code         |
| `sub2+10`     | TR                       |
| `sub2+13..14` | phase tuple `(phA, phB)` |

[confirmed] — a real capture where the first sub-block was 65 bytes (footer
at `inner[57]` instead of `[56]`) is a regression fixture; a fixed-offset
decoder reads garbage on those.

## 4. Code tables

### 4.1 Courses (CS)

All 13 panel courses, cloud-correlated live via a full knob scroll
(2026-06-11). [cloud-correlated, selection packets confirmed]

| byte   | cloud name  | panel name (SE market) | English label used |
| ------ | ----------- | ---------------------- | ------------------ |
| `0x06` | MIXFABRIC   | Blandmaterial          | Mixed Fabrics      |
| `0x09` | QUICKDRY    | Snabbtvätt 30          | Quick Dry 30       |
| `0x0b` | WOOL        | Ylle                   | Wool               |
| `0x3a` | TURBODRY    | Turbodry               | TurboDry           |
| `0x08` | SPORTWEAR   | Sportkläder            | Sportswear         |
| `0x2c` | AI_COURSE   | AI-Torkning            | AI Dry             |
| `0x07` | NORMAL      | Bomull                 | Cotton             |
| `0x19` | COTTONPLUS  | Eko                    | Eco                |
| `0x0a` | DELICATES   | Fintvätt               | Delicates          |
| `0x05` | EASYCARE    | Strykfritt             | Easy Care          |
| `0x15` | TIMEDRY     | Tidsinställd torkning  | Timed Dry          |
| `0x10` | ALLERGYCARE | Allergivård            | Allergy Care       |
| `0x13` | TUBCLEAN    | Skötsel av trummor     | Drum Care          |

History lesson: a course table previously assembled from static references
had **four wrong entries and five phantom bytes** for this machine
(`0x05` was mislabelled Timed Dry, `0x15` Allergy Care, AI was listed at
`0x26`, Eco at `0x1c`; `0x0d`/`0x1b` never existed). Only a live
cloud-correlated scroll is trustworthy.

**`0x21` is NOT a course.** End packets (`ST=0x04`) carry `0x21` at the CS
offset; it is not in the 13-course panel list. Do not decode a programme
from End packets — keep the programme that actually ran. [confirmed]

### 4.2 Phase tuples `(phA, phB)` [confirmed unless noted]

| tuple                                      | phase                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `(05,03)`                                  | Idle (selection display)                                                    |
| `(01,00)`                                  | Startup — broadcast during selection **and** the first ~8 s of a real cycle |
| `(03,09)`, `(03,07)`                       | Heating (`(03,07)` is a transient right after resume)                       |
| `(07,01)`, `(07,03)`                       | Drying (`(07,03)` transient after resume)                                   |
| `(07,10)`, `(07,11)`                       | Cooldown (`(07,11)` is the dominant sustained cool-air tumble)              |
| `(11,00)`, `(08,11)`                       | Finishing (brief states at TR=2 / TR=1 before drum stop)                    |
| `(04,00)`, `(00,03)`, `(03,01)`, `(00,00)` | post-cycle / transition chatter — **unmapped on purpose**; see §6.2         |

**Critical rule: unknown phase tuples must be treated as untrusted.** An
`0xec` packet with an unmapped tuple may not claim running, may not drive a
cycle state machine, and may not update remaining-time (publishing the raw
tuple to a diagnostic sensor is fine). A blocklist approach ("anything not
Idle/Startup is active") caused a duplicate cycle-finished event live —
positively identify activity instead. [confirmed]

## 5. Info-class packets (`inner[8] = 0x02`)

Layout differs from status packets; only ST at `inner[10]` is shared. The
interesting ones have ST = `0x03` and carry a code at `inner[13]`, mirrored
at `inner[17]`.

**The code's meaning is keyed by the sub-payload length byte at
`inner[12]`** — this is the single most subtle finding on this machine:

| `inner[12]` (shape)                | packet len  | codes seen                                                               | meaning                                 |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `0x16` (len 77–81)                 | user events | `0x0c` panel pause · `0x10` idle door event · `0x12` cooldown chime      | [confirmed]                             |
| `0x1e` (len 85)                    | user events | `0x0e` idle panel event                                                  | [confirmed]                             |
| `0x29` (len 96)                    | routine     | **progress counter** — walked `0x07 → 0x08 → 0x09` across one live cycle | [confirmed]                             |
| `0x69` (len 160), `0x75` (len 172) | routine     | misc codes, not user events                                              | [confirmed present, semantics unmapped] |

**Pause detection:** only a code in the user-event shape (`inner[12] =
0x16`) with value `0x0c` (or provisionally `0x07`) may publish Paused.
Without the shape key, the routine counter's `0x07` value produced a
1-second spurious Paused mid-cycle (door untouched, user-confirmed).
[confirmed — live packet is a regression fixture]

`0x07` as "mid-cycle door-open pause" is **[best-guess]**: it remains in the
pause set shape-gated, but no real mid-cycle door pause has been captured to
confirm its actual code. An official implementation should capture one
before relying on it.

## 6. The two duplicate-Done traps (both hit live)

### 6.1 Selection looks identical to a real start

Selection packets carry ST=`0xec` with phase `(01,00)` — **byte-identical to
the first ~8 s of a real cycle**. Neither Idle nor Startup may start the
cycle machine or claim running; the first Heating/Drying packet does.
Accepted trade-off: reported run-state lags ~8–13 s at a real start.
[confirmed]

### 6.2 Post-cycle anti-crease tumble

Five seconds after AntiCrease latched a finished cycle, the machine emitted
a double-block `0xec` packet whose authoritative sub-block carried **TR=1**
(defeating a TR=0-only guard) and the unmapped phase tuple `(04,00)`. Under
a blocklist phase gate this restarted the cycle machine, and the End packet
21 s later produced a **second Done edge**. [confirmed — both packets are
regression fixtures]

Required rules: (a) unknown tuples are untrusted (§4.2); (b) a
finished-latch that only a positively identified Heating/Drying packet may
reset.

## 7. Cycle timeline (live-validated example)

Quick Dry 30, captured 2026-06-12:

```
selection   st=ec ph=(01,00)        → present Standby; course/TR decode (knob browse works)
start       st=ec ph=(07,01) TR=30  → Running / Drying  (~13 s after physical start)
…           TR counts down 30→…→5
finishing   st=ec ph=(08,11)        → Cooling
anti-crease st=e2                   → Done latched, remaining 0
            st=ec ph=(04,00) TR=1   → IGNORED (unknown tuple — the §6.2 trap)
end         st=04 CS=0x21           → run_state End; programme NOT updated
post        st=ec TR=0              → ignored (anti-wrinkle tumble)
standby     st=0b                   → Off
```

## 8. Open questions

1. Real capture of a mid-cycle door-open pause (confirm/replace `0x07`).
2. Real capture of drying-mode browsing (`ST=0xeb`, phA≠`0x05`) — current
   Efficiency/Turbo fixtures are synthetic.
3. Semantics of the large info-class shapes (`0x69`/`0x75`).
4. Post-cycle tuple vocabulary (`(04,00)`, `(03,01)`, …) — intentionally
   unmapped; mapping them is unnecessary if the unknown-tuple rule is
   followed.

## 9. Suggested entity model

| entity                                                     | source                           |
| ---------------------------------------------------------- | -------------------------------- |
| run state (Standby/Running/Paused/Cooldown/AntiCrease/End) | ST + §5/§6 rules                 |
| programme                                                  | CS (never from End packets)      |
| phase (Idle/Heating/Drying/Cooldown/Finishing)             | phase tuple                      |
| remaining time (min)                                       | TR while running                 |
| dryness level / drying mode                                | TR while DisplayOn (§2.2)        |
| derived "stage" with exactly-once Done                     | explicit FSM, see `stage_fsm.ts` |
