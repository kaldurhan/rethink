# LG RHX7009TWS Heat-Pump Dryer (`SDH_X7_7008`) — AABB Protocol Spec

Frame envelope and confidence-tag legend: see [README.md](README.md).
All offsets are inside `inner` (envelope stripped). Dryer frames have
`inner[0] = 0x30`.

> ⚠ These offsets were verified against live captures and **differ from the
> older RH90V9_WW community spec** (ST is at `[10]`, not `[8]`; CS and TR
> are single bytes, not LE u16). Do not copy that spec for this model.

---

## 1. Packet classification

**Note:** `inner[3]` is the frame-length byte, not a packet type (washer
spec §1; verified on dryer frames too — `0x78` = 120-byte main status,
`0x58` = 88-byte End, `0xb0` = 176-byte energy frame). The classification
below already keys on content (`inner[8]`, lengths, state byte), which is
why it survived that discovery unchanged.

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
| `0xeb` | DisplayOn (panel awake; TR carries the programme duration, §2.2)     |
| `0xec` | Running — **also broadcast during selection and post-cycle**, see §6 |
| `0x03` | Cooldown                                                             |
| `0xe2` | AntiCrease (post-end)                                                |
| `0x04` | End                                                                  |

Unknown ST values (e.g. `0x4d` telemetry bursts) must be suppressed.

### 2.2 TR byte semantics (context-dependent)

| context                                      | TR meaning                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ST = `0xec` (running)                        | minutes remaining [confirmed]                                                                 |
| ST = `0xec`/`0xeb` (selection / idle browse) | **programme duration in minutes** (= cloud `initialTimeMinute`) [cloud-correlated 2026-06-12] |
| ST = `0x04` / `0xe2`                         | not meaningful — force remaining-time to 0 [confirmed]                                        |

⚠ **The old "dryness level / drying mode from TR" decode was wrong** — the
same class of error as the washer spin map. `0x1e`/`0x41`/`0x46` are the
**durations** 30/65/70 min of the three dryness settings, and `0x46`/`0x96`
were the 70/150-min durations of mode variants; they merely co-varied with
the settings under one user's habits. The real setting fields (2026-06-12
panel scrolls, cloud-correlated against `dryLevel`/`ecoHybrid`):

| offset      | field          | values                                        |
| ----------- | -------------- | --------------------------------------------- |
| `inner[14]` | dryness level  | `0x01` DAMPDRY · `0x03` IRON · `0x05` VERYDRY |
| `inner[15]` | ecoHybrid mode | `0x02` NORMAL (Efficiency) · `0x03` TURBO     |

Confirmed in 120-byte ST=`0xec` frames — **both during selection and through
an entire running cycle** (2026-06-12 Mixed Fabrics: `[14]/[15]` froze at
`(05,03)` = VeryDry/Turbo for the full cycle while the phase tuple ticked
independently at `sub2+13..14`). In 120-byte frames the single-block offsets
carry the **settings** (`[14]` dryness, `[15]` mode, `[18]` course, `[23]`
remaining — one tick behind `sub2+10`), and the **phase** lives only in
`sub2`. There is no collision; a dryness/mode decoder reads `[14]/[15]` from
any 120-byte frame. ⚠ Open detail: 69-byte DisplayOn frames carry zeros at
`[14]/[15]` — settings are NOT in single-block frames; the old "(05,03) Idle
tuple" sightings were settings misread as phase. Consequence of
TR-as-duration: captured at cycle start, it provides the total-time field
for a % progress sensor. TimeDry sub-scroll: cloud `timeDry` 30/40/50… with
TR tracking 20–180 min.

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
cycle state machine, and may not update remaining-time. Don't publish the
raw tuple to the phase sensor either — post-cycle chatter left
`unknown (3 1)` displayed for hours; keep the last value and log once.
End/AntiCrease display `Finished` (washer parity). A blocklist approach
("anything not Idle/Startup is active") caused a duplicate cycle-finished
event live — positively identify activity instead. [confirmed]

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
0x16`) with value **`0x0c`** may publish Paused. Confirmed for BOTH pause
kinds: panel pause (2026-06-11) and a real mid-cycle door pause
(2026-06-12: pause → door open → close → resume, all captured). The
provisional `0x07` never appeared in a genuine pause — it was only ever the
`0x29`-shape progress counter's first value, which without the shape key
produced a 1-second spurious Paused mid-cycle (door untouched,
user-confirmed). [confirmed — live packets are regression fixtures]

**Door state byte** [confirmed, two sessions]: the door event
(`[12]=0x16`, code `[13]=0x10`, len 81) carries door state at `inner[31]` —
**`0x01` = open, `0x00` = closed** (mid-cycle sequence 2026-06-12 is
unambiguous). ⚠ The idle test initially suggested the opposite polarity —
a wake artifact: opening a _sleeping_ dryer wakes it **without** emitting a
`0x10` door event (same asymmetry as the washer), so that session's first
event was actually the first _close_. An event counter increments at
`inner[21]` (shared across event types). Different state offset than the
washer's `[18]`, same event code. Like the washer, close-from-sleep is
silent — infer closed from positively identified active phases.

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

1. ~~Mid-cycle door-open pause~~ **RESOLVED 2026-06-12**: door pause emits
   `0x0c` (same as panel pause); `0x07` removed from the pause set (§5).
2. ~~Real capture of drying-mode browsing~~ **RESOLVED 2026-06-12 with a
   twist**: the mode (and dryness) never were in TR — see §2.2. The
   `dryness_level`/`drying_mode` sensors need a rework to decode
   `inner[14]`/`inner[15]` instead of duration lookups.
3. Semantics of the large info-class shapes (`0x69`/`0x75`).
4. Post-cycle tuple vocabulary (`(04,00)`, `(03,01)`, …) — intentionally
   unmapped; mapping them is unnecessary if the unknown-tuple rule is
   followed.
5. ~~`[14]/[15]` vs phase coexistence~~ **RESOLVED 2026-06-12**: in 120-byte
   frames the settings live at single-block offsets and the phase only in
   sub2 — confirmed across a full cycle; no collision (§2.2). The
   dryness/mode sensor rework is unblocked.
6. ~~Confirm the door state byte~~ **RESOLVED 2026-06-12**: confirmed
   mid-cycle with corrected polarity (`0x01`=open) — see §5.

## 9. Suggested entity model

| entity                                                     | source                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| run state (Standby/Running/Paused/Cooldown/AntiCrease/End) | ST + §5/§6 rules                                    |
| programme                                                  | CS (never from End packets)                         |
| phase (Idle/Heating/Drying/Cooldown/Finishing/Finished)    | phase tuple; Finished on End/AntiCrease (§4.2)      |
| remaining time (min)                                       | TR while running                                    |
| programme duration (min → % progress)                      | TR at the cycle-start edge (§2.2)                   |
| dryness level / drying mode                                | `inner[14]` / `inner[15]` in 120-byte frames (§2.2) |
| door (open/closed)                                         | door event `[31]` + active-phase inference (§5)     |
| derived "stage" with exactly-once Done                     | explicit FSM, see `stage_fsm.ts`                    |

## 10. Packet-type census (full Mixed Fabrics cycle, 2026-06-06)

`inner[3]` packet-type counts over one complete 70-min cycle
(Mixed Fabrics, Turbo, VeryDry, 15:43–19:26), for orientation — the decoder
classifies by `inner[8]`/length (§1), not by `inner[3]`:

| `inner[3]` | ST           | count | description                                                           |
| ---------- | ------------ | ----- | --------------------------------------------------------------------- |
| `0x13`     | 0x0b Standby | 1     | short standby status                                                  |
| `0x78`     | 0xec Running | 234   | main status (double-block, 116 bytes) — one per minute while running  |
| `0x45`     | 0xe2 / 0xeb  | —     | short status (single-block, 65 bytes) — DisplayOn and AntiCrease      |
| `0x58`     | 0x04 End     | 2     | end-of-cycle status (84 bytes)                                        |
| `0x51`     | 0x03         | 25    | info-class — user events and routine chatter (see §5)                 |
| `0x64`     | 0x03         | 7     | info-class — same pattern as 0x51; also fires mid-drying (~hourly)    |
| `0x82`     | 0x03         | 2     | info-class — boot/init burst                                          |
| `0x59`     | 0x03         | 1     | info-class — single occurrence at end of cycle                        |
| `0xa4`     | 0x03         | 2     | info-class — pre-AntiCrease transition burst                          |
| `0xb0`     | 0x02         | 79    | **periodic sensor/energy data** (~every 2.5 min), len 172 — undecoded |
| `0x30`     | 0x4d         | 3     | course-list report — dropped                                          |

**`0xb0` is the energy decode target.** 79 packets per cycle, len 172 —
probably the same packets as the `0x75` info-class shape (len 172) in §5
[best-guess, unverified]. The cloud's `periodicEnergyData` reports Wh per
15-min interval; decoding `0xb0` against it would enable a local
`course_spend_power` sensor like the washer's. No total-cycle-time field has
been identified either (`sub2+10` is remaining only) — that blocks a %
progress sensor.
