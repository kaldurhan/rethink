# LG F4X7511TWS Washer (`VCDWL2QEUK`) — AABB Protocol Spec

Frame envelope and confidence-tag legend: see [README.md](README.md).
All offsets are inside `inner` (envelope stripped). Washer frames have
`inner[0] = 0x20`.

---

## 1. There is no packet-type byte — `inner[3]` is the frame length

**`inner[3]` is the total frame length (`& 0xff`), not a packet type.**
Verified over 9,600+ frames across every capture on both machines with zero
exceptions (2026-06-12): short frames carry the length at `buf[1]`; `0xff`
there is an escape meaning "length at `buf[5]`" (= `inner[3]`). Every
historical "packet type" matches its frame size exactly — `0x13` = 19-byte
standby, `0x44` = 68-byte DisplayOn, `0x76` = 118-byte running status,
`0x8a` = 138-byte snapshot, `0x53` = 83-byte motor ramp, `0x67` = 103,
`0x9e` = 158…

Real packet identity lives in **content**: the machine-state byte
(`inner[10]`), the info-class marker (`inner[8] = 0x02`), and the shape
constants at `inner[12..13]`. Length values are still useful as dispatch
keys where a length is unique in practice:

| `inner[3]` (length) | Carries                          | Identity check                            |
| ------------------- | -------------------------------- | ----------------------------------------- |
| `0x8a` (138 B)      | Periodic snapshot (~every 5 min) | machine-state `0x02`; see §5              |
| `0x53` (83 B)       | Motor-controller ramp            | `inner[12]=0x18`, step `0x12..0x1f`; §4.3 |
| `0x41` (65 B)       | **Door event** (info-class)      | `inner[12]=0x06, inner[13]=0x10`; §4.2    |
| other               | Status packet                    | decode per §2–§4                          |

⚠ Never key an event on length alone without a content check — the former
door decode keyed on lengths `0x63`/`0x4c` (99/76-byte frames) and read
"open" from unrelated telemetry through entire cycles (§8.1, resolved).

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

All six wheel positions, cloud-correlated live via a full spin-button scroll
(2026-06-12, two complete wheel revolutions, binary↔cloud transitions paired
1:1, plus course-default cross-checks). [cloud-correlated]

| byte   | rpm                   |
| ------ | --------------------- |
| `0x01` | 400                   |
| `0x04` | 800                   |
| `0x06` | 1000                  |
| `0x08` | 1200                  |
| `0x09` | 1400                  |
| `0x0c` | 0 (`SPIN_DRAIN_ONLY`) |

Wheel order: 400 → 800 → 1000 → 1200 → 1400 → drain-only → wrap.

**History lesson (same as the dryer's course table):** the previous map —
assembled from in-cycle observation without cloud correlation — was shifted
by **two wheel positions** on every entry (`0x06` was read as 400; it is 1000) and had been wrongly tagged [confirmed]. Only a live correlated scroll
is trustworthy. `0x27` (seen transiently during drain) is not a wheel
setting; unknown codes must keep the last published value [unmapped].
Course-default cross-checks: Sportkläder and Hand/Ull default to `0x04`
(800), Eco 40-60 to `0x09` (1400), Tub Clean to `0x0c` (drain-only).

## 4. Auxiliary packet types

### 4.1 `0x8a` periodic snapshot (~every 5 min)

| offset      | field                                    |
| ----------- | ---------------------------------------- |
| `inner[23]` | elapsed minutes since door lock (±2 min) |
| `inner[25]` | remaining minutes in the current phase   |
| `inner[31]` | water/drum temperature, °C               |

[confirmed] Machine-state byte in these packets is `0x02` — intercept on
`inner[3] = 0x8a` _before_ any state-table lookup.

### 4.2 Info-class event packets

#### Door events [cloud-correlated]

65-byte info-class frames (`inner[8]=0x02`, machine-state `0x03`) with shape
`inner[12]=0x06` and event code `inner[13]=0x10` — the same code the dryer
uses for its door event. Door state is at `inner[18]`:

| `inner[18]` | meaning |
| ----------- | ------- |
| `0x01`      | open    |
| `0x02`      | closed  |

Verified 2026-06-12: seven alternating events during an idle door test, one
event when the door was closed before the morning's cycle, and the cloud's
`doorLock: ON` arriving seconds after the final close (remote-start arming
locks the door). These frames fire **only** on actual door motion — zero
occurrences mid-cycle in any capture. The frame also carries the model
string (`VCDWL2QEUK`).

**Wake event `[13]=0x11`** [confirmed, asleep-door test 2026-06-12]: opening
the door of a _sleeping_ machine wakes it (keepalive flips `e8`→`e9`,
DisplayOn follows) and emits `[13]=0x11` with the wake cause at `[18]` —
`0x04` = woken by door open. The first open-from-sleep arrives **only** as
this event (no `[13]=0x10` fires for it), so a door decoder must also map
`(0x11, cause 0x04)` → open. Subsequent motion uses normal `[13]=0x10`
events. Other wake causes (power button does **not** emit `0x11`) unknown.

**Close-from-sleep is silent** [confirmed live 2026-06-12]: closing the door
does _not_ wake the machine and emits no event, so the sensor can stick at
"open" indefinitely. Required mitigation: a non-passive Running block
physically implies a closed door — infer `door = closed` from it. Coverage
after both rules: opens always detected; closes detected while the panel is
awake, otherwise corrected at the next cycle start.

#### Pause codes

Info-class packets with a code at `inner[13]` mirrored at `inner[17]`:

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

1. ~~Door events are unreliable~~ **RESOLVED 2026-06-12**: `inner[3]` turned
   out to be the frame-length byte (§1), so the old `0x63`/`0x4c` "door
   types" were just 99/76-byte telemetry frames. Real door events are the
   65-byte info-class frames in §4.2, confirmed by an idle door-test capture.
2. Activity labels for `0x03`/`0x26`/`0x02` (Detecting/Filling/pre-wash)
   are best-guess; confirm on a programme with a weigh step (Bomull/Eco).
3. ~~Spin bytes `0x04` and `0x27` unmapped~~ **RESOLVED 2026-06-12**: full
   wheel cloud-correlated (§3.4); the whole previous map was shifted.
   `0x27` is a transient drain value, not a setting.
4. If a cycle ends while paused, pause-duration accounting upstream of the
   protocol (HA automation layer here) may need to close the open pause.
5. ~~The `[13]=0x11 / [18]=0x04` variant~~ **RESOLVED 2026-06-12**: wake
   event, cause `0x04` = door-open (§4.2). Other wake causes unmapped.
6. ~~Door behaviour while asleep~~ **RESOLVED 2026-06-12**: door motion
   wakes the machine; the first open arrives as the `0x11` wake event,
   the rest as normal `0x10` door events. Full coverage. The keepalive
   state byte (`e8` asleep / `e9` session) is a session bit, not door.

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
| door (open/closed)                                                     | info-class door event, §4.2         |
| derived "stage" with exactly-once Done                                 | explicit FSM, see `stage_fsm.ts`    |

## 10. Known but undecoded packet types

Inventory from deep byte analysis of three Blandmaterial captures
(2026-06-06: partial cycle, ~83-min near-full cycle, end-of-cycle window).
None of these are decoded by the current implementation; they are catalogued
here so future decoding starts from the known constants instead of zero.

| `inner[3]` | ST     | inner len | what is known                                                                                                                                                                                                                           |
| ---------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x67`     | `0x03` | 99        | Per-minute rinse/spin sampler. `inner[12]=0x2c, [13]=0x07` constant; data bytes vary — correlate against cloud `remainTimeMinute`. **Most promising decode target.**                                                                    |
| `0x88`     | `0x03` | 132       | Rinse-cycle event sentinel. Fires in bursts of 3 at each rinse start (3–4×/cycle). `inner[13]=0x06` constant; `~inner[21]` tracks elapsed minutes; `[14..20]` vary per burst (counter or energy accumulator). No load-level byte found. |
| `0x8e`     | `0x03` | 138       | Wash→rinse transition marker — fires 8 s before cloud sees `RINSING`. All bytes constant (`inner[12]=0x53, [13]=0x04, [14]=0x0e`); the packet type itself is the signal.                                                                |
| `0x9e`     | `0x03` | 154       | Large periodic, every ~10 min. `inner[12]=0x63, [13]=0x0f` constant. Purpose unknown — undecodable without more captures.                                                                                                               |
| `0x80`     | `0x03` | —         | Appears once at end-of-cycle, just before End. Purpose unknown.                                                                                                                                                                         |
| `0xa0`     | `0x03` | —         | Appears once at end-of-cycle, just after End. Purpose unknown.                                                                                                                                                                          |
| `0x16`     | `0x4d` | 18        | Once per session after `TCLCount=2`. Purpose unknown. Low value.                                                                                                                                                                        |

**11-byte periodic-energy frame** [cloud-correlated 2026-06-12, two events]:
`aa 0b 20 3e <per_hi> <per_lo> <acc_hi> <acc_lo> <seq> <chk> bb` — fires at
each ~15-min energy interval, mirroring the cloud's `periodicEnergyData`
exactly. `inner[1]=0x3e` marker; interval Wh at `inner[2..3]` **BE**;
accumulated Wh at `inner[4..5]` **BE**; `sequenceNum` at `inner[6]`.
Largely redundant with the `10 08` block (§2.3) but proves interval data
exists locally.

**8-byte event frames** (`aa 08 20 …`) [unmapped]: rare one-off events with
a 3-byte payload. One fired 1 s before the cloud reported
`ezDispenseDrawerState: OPEN` (drawer opened mid-cycle, 2026-06-12) — a
drawer-event candidate, but the only two samples have dissimilar payloads.
Related cloud-only observations from that incident: drawer close and the
`ezDetergentState: EZCSDT_EMPTY` warning produced **no** identified binary
frames, and the cloud `error` field stayed `ERROR_NO` — a mid-cycle drawer
pull surfaces as a panel warning ("dispenser open", user-confirmed), not an
error state. A true error capture still requires a cycle-halting fault.

`0x8a` extras beyond the three published fields (§4.1): `inner[31..35]` is a
run of five temperature sensor points (36–49 °C during rinse; only `[31]` is
published); `inner[20]` and `inner[30]` are internal counters [confirmed but
not published]. `0x53` extras: during the final spin, `inner[25+]` carries
non-zero motor speed/torque data (zeros during gentle tumble) — units unknown;
could expose instantaneous spin RPM if decoded.

### Cloud-side fields with no known binary source

For reference when hunting bytes (cloud values are correlation targets only —
this project publishes nothing from the cloud feed):

| cloud field             | values                                     | binary status                                                      |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `loadLevel`             | `LOAD_LEVEL_1..9` (~1 min after door lock) | not found; needs light-vs-heavy paired captures                    |
| `soilWash`              | `SOILWASH_HEAVY/LIGHT/NORMAL`              | not visible in `0x8a`; needs same-course different-soil comparison |
| `turboWash`             | `TURBOWASH_ON/OFF`                         | not hunted                                                         |
| `error`                 | `ERROR_NO`                                 | no binary equivalent confirmed; needs a real fault                 |
| `initialTimeMinute`     | total programmed minutes                   | `sub[15]` low byte matches [best-guess]                            |
| `accumulatedEnergyData` | running Wh total                           | binary `courseSpendPower` (§2.3) covers this                       |

Cloud `state` progression over a normal cycle, for correlation:
`INITIAL → DETECTING → DETERGENT_INPUT → RUNNING → RINSING → SPINNING → END`.
