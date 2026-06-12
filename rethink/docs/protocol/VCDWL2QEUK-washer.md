# LG F4X7511TWS Washer (`VCDWL2QEUK`) — AABB Protocol Spec

Frame envelope and confidence-tag legend: see [README.md](README.md).
All offsets are inside `inner` (envelope stripped). Washer frames have
`inner[0] = 0x20`.

---

## 1. Packet types (`inner[3]`)

Dispatch on `inner[3]` **before** looking at the machine state — several
packet types carry machine-state bytes that are not in the state table.

| `inner[3]` | Meaning                          | Notes                                                    |
| ---------- | -------------------------------- | -------------------------------------------------------- |
| `0x63`     | Door **open** event              | [confirmed] but see §8.1 — a length-collision bug exists |
| `0x4c`     | Door **close** event             | [confirmed]                                              |
| `0x8a`     | Periodic snapshot (~every 5 min) | machine-state byte is `0x02`; see §5                     |
| `0x53`     | Motor-controller ramp            | machine-state byte is `0x03`; see §4.3                   |
| other      | Status packet                    | decode per §2–§4                                         |

## 2. Status packets

### 2.1 Machine state — `inner[10]`

| value  | state             | notes                                                              |
| ------ | ----------------- | ------------------------------------------------------------------ |
| `0x0b` | Standby           | short packet (inner ≈ 19 bytes), no sub-block                      |
| `0xeb` | DisplayOn         | panel awake, drum off                                              |
| `0xec` | Running           | **also broadcast during selection and post-cycle** — see §6        |
| `0x04` | End               | cycle finished; this packet type has **no valid status sub-block** |
| `0xe2` | AntiCrease        | post-end periodic tumble state                                     |
| `0x4d` | (telemetry burst) | not a state — **suppress**, do not publish [confirmed]             |

Unknown values appear during init/telemetry; suppress rather than publishing
a garbage state.

### 2.2 The status sub-block

Long status packets (inner ≥ ~32 bytes; commonly 114 bytes) contain one or
two 21+ byte **status sub-blocks**. The authoritative one is the **last**
in the packet — scan backwards. [confirmed]

Sub-block layout (offsets relative to sub-block start, `sub[0]` = marker):

| offset        | field                           | notes                                                                       |
| ------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `sub[0]`      | marker                          | `0x05`, `0x03`, or `0x00` (block variants; all carry the same field layout) |
| `sub[1..2]`   | **display tuple**               | temp index + settled marker — _not a phase_; see §3.2                       |
| `sub[3]`      | spin-speed code                 | see §3.4                                                                    |
| `sub[4]`      | course code                     | see §3.1                                                                    |
| `sub[5]`      | always `0x00`                   | locator anchor (LE high byte of course)                                     |
| `sub[13..14]` | remaining time, minutes, LE u16 |                                                                             |
| `sub[15]`     | initial/total time low byte     | [best-guess; only the low byte verified]                                    |
| `sub[19]`     | course code repeated            | locator anchor                                                              |
| `sub[20]`     | **drum-activity code**          | the real cycle phase; see §3.3                                              |
| `sub[21]`     | previous drum-activity code     | echo of the prior `sub[20]` value [confirmed]                               |

#### Locator algorithm [confirmed]

```
for i from inner.length-21 down to 14:
    if inner[i] not in {0x05, 0x03, 0x00}: continue   # marker
    if inner[i+4] == 0x00:                 continue   # course present
    if inner[i+5] != 0x00:                 continue   # anchor
    if inner[i+19] != inner[i+4]:          continue   # course repeat
    rem = inner[i+13] | inner[i+14] << 8
    if rem > 360:                          continue   # Guard A, see §7
    return i
return none
```

Both guards in §7 are **required**, not optional hardening.

### 2.3 Energy block

Running packets carry a `10 08` marked block (scan for the **last**
occurrence of bytes `10 08`):

| offset from block start | field                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `+2`                    | course code                                                      |
| `+11..12`               | remaining time, LE u16, minutes                                  |
| `+14..15`               | cycle energy so far, **big-endian** u16, Wh (`courseSpendPower`) |

[confirmed] — matches the cloud's `courseSpendPower` field exactly.

## 3. Code tables

### 3.1 Courses — `sub[4]`

All 15 panel courses, cloud-correlated live via a full knob scroll
(2026-06-11). [cloud-correlated, selection packets confirmed]

| byte   | cloud name        | panel name (SE market)     |
| ------ | ----------------- | -------------------------- |
| `0x2b` | MIX               | Blandmaterial              |
| `0x7a` | TURBO39           | Turbowash 39               |
| `0x4b` | SPEED14           | Quick 14                   |
| `0x4f` | SPORTS_WEARS      | Sportkläder                |
| `0x55` | TUB_CLEAN         | Rengöring av trumman       |
| `0x13` | COTTONECO         | Eco 40-60                  |
| `0x5e` | WOOL              | Hand / Ull                 |
| `0x2e` | NORMAL            | Bomull (Cotton)            |
| `0x72` | AI_COURSE         | AI - Tvätt                 |
| `0x16` | DELICATES         | Fintvätt                   |
| `0x1d` | EASYCARE          | Strykfritt                 |
| `0x88` | MICROPLASTIC_CARE | Skötsel av mikroplaster    |
| `0x04` | ALLERGY_SPASTEAM  | Allergivård                |
| `0x37` | RINSE_SPIN        | Sköljning + Centrifugering |
| `0x4e` | SPIN_ONLY         | Centrifugering             |

The cloud also sends the complete ordered dial list once per session as
`PANEL_COURSE_LIST` — use it to verify completeness for other markets.

### 3.2 Display tuple — `sub[1..2]` (NOT a phase)

`sub[1]` is the temperature index while the tuple is a settled/browse code;
`sub[2]` is a settled marker. The tuple freezes for entire cycles (an Eco
40-60 ran start-to-finish at `(03,0e)`), so **never derive cycle phase from
it**. [confirmed]

Settled / browse codes (use only to gate temperature decoding):
`0x0210 0x0310 0x0510 0x0810 0x0610` (settled temp display) and
`0x010e 0x020e 0x030e 0x050e` (programme-selection browsing).
`0x0110` is the _scroll-in-progress_ code — temperature must not be
published until the display settles. [confirmed]

Temperature index at `sub[1]` [cloud-correlated via a temp scroll on
Cotton, full circle Cold→20→30→40→60→95]:

| `sub[1]` | temperature |
| -------- | ----------- |
| `0x08`   | Cold        |
| `0x01`   | 20 °C       |
| `0x02`   | 30 °C       |
| `0x03`   | 40 °C       |
| `0x05`   | 60 °C       |
| `0x06`   | 95 °C       |

### 3.3 Drum-activity codes — `sub[20]` (the real cycle phase)

`sub[21]` always echoes the previous code, giving a free plausibility
check. Observed full sequence across Eco 40-60 and Quick 14 cycles:

```
0x01 (selected) → 0x03 → 0x26 → 0x02 → 0x0b (wash; 0x26↔0x0b refill
alternation) → 0x0c (rinse) → 0x0e (drain + final spin) → 0x10 (finished)
→ 0x00 (post-cycle idle)
```

| code   | phase                                    | confidence                                                                                   |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `0x01` | Idle (programme selected / temp scroll)  | [confirmed] — this is also the "selection terminator": selection blocks always end `(01,00)` |
| `0x03` | Detecting (load weighing)                | [best-guess] — observed at cycle start once; did **not** appear at a Turbowash 39 start      |
| `0x26` | Filling                                  | [best-guess] — recurs during wash as `26↔0b` alternation, consistent with refill bursts      |
| `0x02` | Washing (pre-tumble)                     | [best-guess]                                                                                 |
| `0x0b` | Washing (main tumble)                    | [confirmed]                                                                                  |
| `0x0c` | Rinsing                                  | [confirmed] — span lengths match rinse windows in two different programmes                   |
| `0x0e` | Spinning (covers drain + final spin)     | [confirmed]                                                                                  |
| `0x10` | Finished (post-cycle anti-crease tumble) | [confirmed]                                                                                  |
| `0x00` | Post-cycle idle                          | [confirmed]                                                                                  |

Unknown codes: keep the last published phase and log once — do not publish
a raw value into an enum.

**Passive codes** `{0x00, 0x01, 0x10}`: blocks carrying these mean the drum
is _not_ actively cycling. While machine-state is `0xec`, passive blocks
must not claim "running", must not start your cycle state machine, and
(for `0x10`/`0x00`) must not update remaining-time — post-cycle tumble
blocks carry a leftover `rem=1` that otherwise blips the countdown after
End. [confirmed]

### 3.4 Spin-speed codes — `sub[3]`

| byte   | rpm                                                         | confidence  |
| ------ | ----------------------------------------------------------- | ----------- |
| `0x06` | 400                                                         | [confirmed] |
| `0x08` | 800                                                         | [confirmed] |
| `0x09` | 1000                                                        | [confirmed] |
| `0x0c` | 1200                                                        | [confirmed] |
| `0x01` | 1400                                                        | [confirmed] |
| `0x04` | ? (default of Sportkläder and Hand/Ull — likely 600 or 800) | [unmapped]  |
| `0x27` | ? (seen in a Blandmaterial final spin)                      | [unmapped]  |

A 2-minute spin-speed scroll with the cloud feed running would close both
gaps (same method as the course validation).

## 4. Auxiliary packet types

### 4.1 `0x8a` periodic snapshot (~every 5 min)

| offset      | field                                    |
| ----------- | ---------------------------------------- |
| `inner[23]` | elapsed minutes since door lock (±2 min) |
| `inner[25]` | remaining minutes in the current phase   |
| `inner[31]` | water/drum temperature, °C               |

[confirmed] Machine-state byte in these packets is `0x02` — intercept on
`inner[3] = 0x8a` _before_ any state-table lookup.

### 4.2 Info-class pause packets

Info-class packets have `inner[8] = 0x02` and machine-state `0x03`, with a
code at `inner[13]` mirrored at `inner[17]`:

| code   | meaning                                                           |
| ------ | ----------------------------------------------------------------- | ------------------------------------------ |
| `0x0c` | **Paused** (correlated with cloud state PAUSE) [cloud-correlated] |
| `0x0b` | detergent input                                                   | occurs during a normal cycle — not a pause |
| `0x01` | detecting                                                         | not a pause                                |
| `0x11` | idle panel browse                                                 | not a pause                                |
| `0x1e` | pre-detect                                                        | not a pause                                |

Only `0x0c` may publish Paused. ⚠ The dryer's equivalent codes turned out
to be **shape-dependent** (meaning keyed on the sub-payload length at
`inner[12]`); the washer codes above were mapped without that key and have
not produced a false positive live, but a shape audit is prudent before an
official implementation (see dryer page §5).

### 4.3 `0x53` motor-controller ramp

`inner[12] = 0x18` (motor active) with `inner[13]` = speed step
`0x12..0x1f`. Fires concurrently with status packets during gentle tumble
**and exclusively during the final drain+spin** (status tumble packets go
silent for 15+ min there). [confirmed]

This packet is useful as a _secondary_ signal for rinse/spin detection
(first ramp after wash = rinse began; ramp after >90 s of tumble-packet
silence = final spin). However, the activity codes (§3.3) flag Spinning
**~85 s earlier** than this heuristic — a new implementation should derive
phases purely from activity codes and may not need `0x53` at all.

## 5. Cycle timeline (live-validated example)

Turbowash 39, captured 2026-06-12, all on the current decoder:

```
selection   st=ec  act=01  (Standby presented; knob flickers decode correctly)
start       st=ec  act=0b  → Washing        (cycle state machine starts)
            st=ec  act=26↔0b               (refill bursts: Filling↔Washing)
rinse       st=ec  act=0c  → Rinsing
spin        st=ec  act=0e  → Spinning      (remaining_time counts 9→…→0 live)
end         st=04          → run_state End  (no sub-block in End packets)
anti-crease st=e2          → phase Finished, remaining_time forced 0
post-cycle  st=ec  act=10  (passive tumble bursts — must not restart anything)
            st=ec  act=00  (post-cycle idle)
standby     st=0b          (user opens door / panel timeout)
```

## 6. Suppression rules (what NOT to publish)

1. **Selection blocks** (`sub[20] = 0x01`): machine-state `0xec` must not
   claim running; keep the last meaningful state (fall back to Standby on a
   fresh cache). Course/temperature/remaining _do_ publish — that is what
   makes knob-browse decoding work. [confirmed]
2. **Post-cycle blocks** (`sub[20] ∈ {0x10, 0x00}`): same non-claim rule;
   additionally skip remaining-time (leftover `rem=1`). [confirmed]
3. **Do not key any suppression on the display tuple.** A previous decoder
   suppressed packets whose display tuple read "finished" (`0x0000`) — but
   `(00,00)` also appears on **live final-spin packets**, which froze
   remaining-time and run-state through every spin. The fix was suppression
   by activity code only. [confirmed — the live packet is a regression
   fixture]
4. **End packets (`0x04`) carry no valid sub-block** — never decode
   course/phase/remaining from them.

## 7. Locator guards (both required)

A 114-byte packet variant contains overlapping repeated structures that
fake a valid-looking sub-block at a shifted offset (observed at `blk@73`),
with a real course byte and garbage elsewhere. Two live incidents:

- fake block with `rem=2304` (absurd) — caught by **Guard A**:
  reject candidates whose remaining-time exceeds 360 min and keep
  scanning; this _recovers the true block_ in the same packet. Legit
  blocks across all captures read ≤ 152.
- fake block with `rem=256` (plausible!) and course `0x04` while Eco
  (`0x13`) was running — caught by **Guard B**: while a cycle is active, a
  block claiming a _different course_ than the running one is physically
  impossible (the panel locks the dial) — discard the entire sub-block.

[confirmed — both live packets are regression fixtures]

## 8. Known bugs / open questions

1. **Door events are unreliable.** A 0x63-byte-_long_ info packet collides
   with the `inner[3] = 0x63` door-open intercept: the door sensor reads
   "open" through entire cycles. Real door events may be the short
   `aa 08 20 …` frames (currently discarded as too short). Needs an
   idle door-open/close capture to resolve. **Do not ship a door sensor
   from `inner[3]` alone.**
2. Activity labels for `0x03`/`0x26`/`0x02` (Detecting/Filling/pre-wash)
   are best-guess; confirm on a programme with a weigh step (Bomull/Eco).
3. Spin bytes `0x04` and `0x27` unmapped (§3.4).
4. If a cycle ends while paused, pause-duration accounting upstream of the
   protocol (HA automation layer here) may need to close the open pause.

## 9. Suggested entity model

What this decoder publishes, all live-validated:

| entity                                                                 | source                              |
| ---------------------------------------------------------------------- | ----------------------------------- |
| run state (Standby/Running/Paused/End/AntiCrease)                      | `inner[10]` + §6 rules              |
| course/programme                                                       | `sub[4]`                            |
| cycle phase (Idle/Detecting/Filling/Washing/Rinsing/Spinning/Finished) | `sub[20]`                           |
| remaining time (min)                                                   | `sub[13..14]` (gated per §6)        |
| temperature setting                                                    | `sub[1]` when display tuple settled |
| spin speed (rpm)                                                       | `sub[3]`                            |
| cycle energy (Wh)                                                      | `10 08` block                       |
| elapsed / phase-remaining / water temp                                 | `0x8a` snapshot                     |
| derived "stage" with exactly-once Done                                 | explicit FSM, see `stage_fsm.ts`    |
