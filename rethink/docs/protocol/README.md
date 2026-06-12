# LG AABB Protocol — Reverse-Engineered Specification

Protocol documentation for two LG laundry appliances speaking the local
"AABB" binary protocol, reverse-engineered against live machines in
June 2026:

| Appliance                            | ThinQ model ID | Spec page                                    |
| ------------------------------------ | -------------- | -------------------------------------------- |
| LG F4X7511TWS front-load washer      | `VCDWL2QEUK`   | [VCDWL2QEUK-washer.md](VCDWL2QEUK-washer.md) |
| LG RHX7009TWS heat-pump tumble dryer | `SDH_X7_7008`  | [RHX7009TWS-dryer.md](RHX7009TWS-dryer.md)   |

Every claim in these pages is tagged with a confidence level:

- **[confirmed]** — verified against multiple live captures and protected by
  a regression test with the real packet as fixture
- **[cloud-correlated]** — verified by capturing the binary feed and the LG
  cloud MQTT feed side-by-side and matching transitions in real time
- **[best-guess]** — consistent with observed behaviour but not
  independently verified; treat as provisional

---

## 1. Frame envelope

Both appliances wrap every message in the same envelope:

```
AA <length> <inner bytes…> <checksum> BB
```

- `length` = inner length + 4
- A `length` byte of `0xff` is an **escape**: the real length is at `buf[5]`
  (= `inner[3]`). This is why long-frame `inner[3]` values were historically
  mistaken for "packet types" — they are frame lengths (washer spec §1;
  verified over 9,600+ frames on both machines, 2026-06-12).
- `checksum` = (sum of all preceding bytes, including AA and length) & 0xFF, XOR 0x55
- All multi-byte integers inside `inner` are **little-endian** unless noted.

Everything below refers to offsets **inside `inner`** (envelope stripped:
`buf[2 .. len-2]`).

`inner[0]` is the appliance family discriminator:

- `0x20` — washer frames
- `0x30` — dryer frames

Frames with other values (`0x31`, telemetry noise) appear occasionally and
must be ignored.

### Keepalive frames (7 bytes)

Both machines emit `aa 07 <family> <state> <seq> <chk> bb` every ~2 s at all
times. The state byte is a **session bit** [confirmed across all 2026-06-12
captures, both machines]:

| state  | meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `0xe9` | session active (panel awake, cycle running, paused, anti-crease) |
| `0xe8` | asleep — returns ~90 s after the panel sleeps                    |
| other  | one-off event values (`0x19`/`0xd8`/`0xc3`/`0x7f`) — ignore      |

`0xe8` never appears during an active session (0 of ~3,300 keepalives in a
100-min wash); one transient mid-session blip was observed, so require a
streak (~20 s) before acting. **Use it**: a sustained `0xe8` streak is the
only signal an asleep machine emits — it corrects post-cycle states
(End/AntiCrease) left stale by a missed Standby frame or a retained MQTT
value restored after a bridge restart. A `0xf0`-family keepalive variant
appears while the bridge is restarting — excluded by the family check.

## 2. The four cross-cutting traps

These bit us live within minutes of each deployment. Any implementation
**will** hit them; design for them up front.

### 2.1 "Running" is broadcast during programme selection

Both machines broadcast machine-state `0xec` ("Running") **while a programme
is merely selected on the panel** — drum off, door open, user just turning
the knob. [confirmed]

If you map `0xec → running` naively, your integration reports a phantom
cycle every time someone browses the programme dial. Each appliance has a
reliable discriminator (see the per-device pages): the washer's
activity/terminator byte, the dryer's phase tuple.

### 2.2 Two independent "phase" namespaces (washer)

The washer's status block contains **two phase-like fields that must never
be mixed**:

- `sub[1..2]` — a _display/selection_ code (temperature index + settled
  marker). It can stay frozen for an **entire cycle**.
- `sub[20]` — the _drum-activity_ code that actually progresses through the
  cycle (`sub[21]` echoes the previous value).

Early decoders that read `sub[1..2]` as the cycle phase produced phases that
were wrong for hours at a time, and — worse — suppression heuristics keyed
on it ate live packets (see washer page §6). [confirmed]

### 2.3 Info-class packets have shape-dependent codes (dryer)

Dryer info-class packets (`inner[8] = 0x02`, machine-state `0x03`) carry a
code at `inner[13]` (mirrored at `inner[17]`) whose **meaning depends on the
sub-payload length byte at `inner[12]`**. The same numeric code value means
"user pressed pause" in one shape and "routine progress counter" in another.
Keying on the code alone produced spurious Paused states mid-cycle.
[confirmed]

### 2.4 Status-block locator mis-picks (washer)

The washer's long packets contain repeated/overlapping sub-block structures;
a signature-scan locator occasionally latches onto a shifted false block
with a plausible-looking course byte and garbage values. Two guards are
required (washer page §7). [confirmed]

## 3. End-of-cycle behaviour (both machines)

After a cycle ends, both machines keep transmitting for minutes:

1. machine-state `End` (`0x04`) and/or `AntiCrease` (`0xe2`) packets
2. periodic **anti-crease/anti-wrinkle tumble bursts** that broadcast
   machine-state `0xec` ("Running") again with near-running payloads

The tumble bursts are the most dangerous packets in the protocol: on both
machines they have produced duplicate "cycle finished" events when
misclassified as a new cycle. Each appliance page documents the exact
discriminators. If your integration emits notifications, make the
finished-edge **exactly-once by construction** (a latch that only a
positively-identified new cycle start may reset). [confirmed]

## 4. Capture & validation methodology

Everything here was derived with three complementary captures; the same
method extends the spec to new appliances or unconfirmed fields:

1. **Raw binary feed** — record every frame as hex with timestamps
   (NDJSON). Keep the raw log forever; every later question is answered by
   re-decoding it.
2. **Cloud MQTT reference feed** — run the LG cloud connection in parallel
   (read-only) and log `washerDryer.*` field changes. The cloud names label
   binary bytes in real time. Gotchas: `washerDryer.course` is
   authoritative; `baseDownloadCourseData` lags and garbles. The cloud does
   **not** expose wash/rinse/spin sub-phases — only coarse state — so phase
   decoding must come from timing analysis of the binary feed.
3. **Panel-knob scrolls** — power the panel on and scroll through every
   programme, pausing ~3 s on each. Selection packets carry the course
   byte; the cloud feed (and `PANEL_COURSE_LIST`, which the cloud sends
   once) names each one. This validated all 15 washer + 13 dryer courses in
   ~10 minutes total — including finding 4 wrong and 5 phantom entries in a
   table previously assembled from static references.

Validation runs use a monitor asserting: exactly one Done edge per machine
per cycle, forward-only phase walk, no spurious Paused, and an independent
power-meter cross-check (smart-plug watts vs reported state).

**Full-cycle replay tests** are the backbone: commit a complete cycle's raw
NDJSON as a fixture, replay it through the decoder with mocked wall-clock
time (decoders may contain real-time gates), and assert the exact state
walk. This catches whole classes of regressions that unit fixtures miss.

## 5. Reference implementation

- Washer decoder: `cloud/devices/VCDWL2QEUK.ts`
- Dryer decoder: `cloud/devices/RHX7009TWS.ts`
- Exactly-once stage machine: `cloud/devices/stage_fsm.ts`
- Replay fixture (full Eco 40-60 cycle, raw): `tests/fixtures/eco-cycle-raw.ndjson`
- 300+ tests with real captured packets as fixtures: `tests/cloud/devices/`
