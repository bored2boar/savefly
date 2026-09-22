# Test plan

## A. Performance

| # | What | Criterion |
|---|---|---|
| A1 | Frame time under different load: 0/4/12 spiders × 0/40 shots | < 4 ms |
| A2 | Frame time in the worst weather: storm + downpour + lightning | < 5 ms |
| A3 | Simulation throughput, steps/s | > 200k |
| A4 | Cold start scaling: 1h / 1d / 7d / 30d | < 2 s for any |
| A5 | Memory growth over 500k steps | no leak |
| A6 | Collector at a high rate: 500 trades/min | does not fall behind |
| A7 | CSV parsing, rows/s | > 500k |
| A8 | Snapshot cost: write and restore | < 5 ms |

## B. Determinism and shared state

| # | What | Criterion |
|---|---|---|
| B1 | Different FPS, shared moment | same hash |
| B2 | Different join time | same hash |
| B3 | Snapshot = full replay | hash to the bit |
| B4 | Old snapshot vs fresh | same hash on a shared step |
| B5 | Death and hatching between a snapshot and "now" | same hash |
| B6 | Divergence on a long run: 1M steps | zero divergences |

## C. Feed edge cases

| # | What | Expected |
|---|---|---|
| C1 | Empty log | graceful degradation |
| C2 | One event | works |
| C3 | All events on one timestamp | deterministic, ordered by blk+sig |
| C4 | Events out of order in CSV | get sorted |
| C5 | Duplicate signatures | deduplicated |
| C6 | Corrupted rows: truncated, extra fields, NaN | skipped |
| C7 | sol: 0, negative, 1e9 | does not break |
| C8 | px: 0, negative | does not break |
| C9 | Price spike ×10^6 and back | ATH not poisoned |
| C10 | Gap in the log | recorded, state not broken |
| C11 | Shard vanished between polls | no crash |
| C12 | meta.json missing or corrupted | falls back to demo |
| C13 | state.json from another pool | not accepted blindly |
| C14 | Server without Range | fallback path |
| C15 | 404 on the current hour | not an error |
| C16 | Client clock skewed ±10 min | does not break |

## D. Extreme economics

| # | What | Expected |
|---|---|---|
| D1 | Instant rug -99.9% | death |
| D2 | Endless pump | no death, silk 0 |
| D3 | Zero activity for hours | state freezes, does not die |
| D4 | Buys only | silk 0, intercept 100% |
| D5 | Sells only | death within reasonable time |
| D6 | One whale 10,000 SOL | size capped, does not kill alone |
| D7 | Dust only | zero entities, price moves |
| D8 | Death-hatch chain ×20 | generations counted, state intact |
| D9 | Price exactly 0 | no division by zero |
| D10 | ATH = 0 | no division by zero |

## E. Numeric stability

| # | What | Expected |
|---|---|---|
| E1 | Price 1e-12 | no denormalization |
| E2 | Price 1e12 | no precision loss in the hash |
| E3 | NaN / Infinity in an event | does not leak into state |
| E4 | Step > 2^31 | hash does not break |
| E5 | Float accumulation over 5M steps | silk within [0,1.05] |


---

# Run results

Full set: **42 tests, 42 pass**.
Platform: Intel Xeon 2.10GHz, cairo CPU, node v22.

## A. Performance

| Metric | Value | Limit |
|---|---|---|
| Empty simulation steps | 6,022,080 steps/s | > 200k |
| Steps with events and entities | 135,318 steps/s | > 100k |
| CSV parsing | 1,333,905 rows/s | > 500k |
| Snapshot write | 0.09 ms | < 5 |
| Snapshot restore | 0.07 ms | < 5 |
| Snapshot size | 3,929 bytes | < 20k |
| Heap growth over 500k steps | -14.9 MB | no leak |
| Tail replay from a 2 h old snapshot | 466 ms | < 2000 |

Frame time:

| Scenario | ms | fillRect |
|---|---|---|
| Calm | 1.15 | 556 |
| 4 spiders, 10 shots | 1.82 | 1,072 |
| 12 spiders, 40 shots | 3.12 | 1,852 |
| Silk 0.9 + 12 spiders | 2.82 | 1,758 |
| Storm with rain | 3.07 | 2,154 |
| Night, downpour, lightning | **3.67** | 2,308 |

## Bugs found and fixed

**Bar-based ATH was documented but missing from the code.**
A replacement missed its line, and the tick-based `if(S.px>S.pxAth)` stayed in the code.
The `bar`/`barHi` fields existed in the state and in the hash, but were never updated.
The improvements on fresh launches came only from `DD_CAP` and `BIRTH_GRACE`.

**A price spike ×10^6 poisoned the ATH forever** (C9). One garbage tick
set the high a million times higher, and the drawdown became fictional.
Added a growth limit: ATH at most ×4 per bar.

**Infinity in the price turned silk into NaN** (E3), and the state became
unusable irreversibly. Added input sanitization in
`simApplyEvent`.

**A foreign or corrupted `state.json` was accepted wholesale** (C13). The client
froze at `gen=77, step=999999999`. Added `ckValid()`: checks the
step against genesis time and the log, and the ranges of all fields.

**The worst frame was 5.12 ms.** The cause: with 12 spiders all
12 spokes vibrated and the web was redrawn entirely. Limited to the six
strongest. Now 3.67 ms.

## What the tests do not cover

- Real mobile browsers
- The collector under a load of 500+ trades/min (A6) - no such pool available
- Behavior with 100+ simultaneous clients on one CDN


---

# Second pass: searching the blind spots

The first set tested the simulation. The second - what the simulation
tests do not look at: the render layer, the event queue, shard rotation.
**7 new bugs found.**

## Shard rotation (the most serious)

| Test | Before | After |
|---|---|---|
| Size rotation mid-run | FAIL | PASS |
| Hour rollover mid-run | FAIL | PASS |

**The client computed the tail shard name itself** - `shardName(Date.now())`
always gave `...T11.csv`, with no suffix. When the collector moved on after 4 MB
to `...T11.1.csv`, the client kept pulling a file that no longer grew.
Live events simply disappeared, without any error.

The same on an hour rollover.

Fixed: the tail is dictated by `meta.json`, not computed. Plus the client
reads shards that appeared between polls.

**The collector's suffix was not reset when the hour changed.** Having reached `.2` at 10:00,
at 11:00 it wrote `2026-09-19T11.2.csv`, while `.0` and `.1` did not exist.
The client could not find the tail at all.

**Shard order in meta was lexicographic**, and there `T10.1.csv` comes
**before** `T10.csv`, and `T10.10.csv` before `T10.2.csv`. The wrong file
was chosen as the tail. Added sorting by (hour, number).

## Render layer

**Leg debris and particles had no cap.** A series of kills gave `legs=3840`
and `fx=2880`, and `drawLegs` iterates the whole array every frame. Added
`LEGS_CAP=160`, `FX_CAP=240` with eviction of the oldest.

**Event queue overflow was silent.** When catching up on more than 400
events per frame the rest were dropped - the log undercounted bites and kills,
even though the counters in the header stayed accurate. Added `OUTDROP` and one
summary line: `BURST: N events happened faster than they could be shown`.

**Several generations in one frame were described by a single DNA.** `applyGen()`
took the current `S.seed`, not the seed from the event, so both log lines
named the last fly. And the death line already carried the new name.
The seed is now passed explicitly, in the death event too.

## Snapshot validation

`ckValid()` checked the state fields, but **not the entities**. A snapshot with
`spoke=99` crashed `spokeStatic` (access to `SPOKE[99]`), and a `NaN`
in a spider coordinate poisoned the state irreversibly. Added shape
and range checks for every spider and shot.

## Summary of both passes

| Pass | Tests | Bugs found |
|---|---|---|
| First (sim) | 42 | 5 |
| Second (render, storage) | 27 | 7 |
| **Total** | **69** | **12** |

Frame time after the second pass: calm 1.18, worst 4.59 ms.


---

# Fuzzer

Fixed tests check what the author anticipated. The fuzzer -
random event streams and a check of invariants that must
hold always. The seed is printed, so any failure
is reproducible.

## What is generated

- 5-250 events per stream, six size modes: dust only,
  normal, rare whales, a spread over 14 orders of magnitude (1e-8..1e6),
  half zeros
- price at scales from 1e-12 to 1e9, with random drift
- in 3% of events the price or volume is replaced with `0`, `-1`, `NaN`,
  `Infinity`, `1e308`, `1e-320`
- a quarter of the streams are a guaranteed rug with sells dominating at
  72-96%, so the fuzzer reaches deaths and generation changes

## What is checked

- silk in `[0, 1.06]`, debt and flow non-negative and finite
- counters are integers and non-negative, generation >= 1
- entities within bounds: spiders <= 64, shots <= 200,
  `t` in `[-0.6, 1.6]`, `size` in `(0, 3.01]`, `spoke` in `[0, 12)`
- no NaN in coordinates
- **snapshot chain**: every snapshot, restored separately, gives the
  same final hash as a full replay
- **double round-trip**: snapshot -> restore -> snapshot does not change the data
- **CSV round-trip**: an event written to a log row and read
  back gives the same state
- the same seed twice - the same hash

## Findings

| Pass | Iterations | Found |
|---|---|---|
| 1 | 400 | snapshot drift: `toFixed` in `snapshot()` |
| 2 | 26,400 | clean; a suspicion led to rounding in the collector |
| 3 (extended) | 10,800 | clean |

Both bugs are of one class: **precision loss during serialization**.
The fixed tests missed both, because they checked with round numbers.

## Third pass coverage

18 batches of 600 iterations: about 1,800 deaths, 1,300 streams with a
generation change, 27,000 snapshot links, 3,600 CSV round-trips.
