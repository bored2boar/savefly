# Known unfixed issues

As of v0.5.0. Tests: 69, all pass. This is what the tests
**do not close** or close deliberately only in part.

## Blocking launch

### 1. The provider ceiling
The provider serves 300 trades per request. There is no pagination - verified
`limit`, `page`, `cursor`, all return the same 300. So the collector cannot
capture more than `300 / poll_interval`.

**Partly mitigated by the dust filter.** The game drops trades smaller
than `DUST_SOL` anyway, so there is no point spending window slots on them. Now
the collector asks the provider to filter them on its side
(`minUsd`, default $10). Measured window widening:

| Threshold | 300-trade window |
|---|---|
| $0 | 7.7 min |
| $3 | 9.4 min |
| $10 | **11.7 min** |
| $50 | 16.0 min |

So the ceiling rose from about 2250 to 3400 significant trades/min
on this token, and more so the more dust the token has.

The request limit is now under control too: a hard budget
`maxPollsPerMin` (7) with waiting, not hoping.

**What remains:** a hot pump can exceed even this. Such tokens
need a websocket stream (Bitquery, Helius). The collector itself is not the
bottleneck: 27,000 events/s, headroom x270.

### 2. On-chain death recording does not exist
No contract, no keeper wallet. Open questions for the partner:
who pays gas, who holds the key, what makes the claim true
with a centralized keeper.

**Until there is an answer, the wording "the death is recorded on chain
forever" must not be used.**

A partial substitute already exists: `data/deaths.csv` - an append-only registry,
where every row is tied to the signature of the last transaction before
the death and is verified by replaying the log. It is an honest registry,
but **not a contract record**.

### 3. Mobile browsers - checked superficially
Vlad checked it on a real device: it looks fine. That is a smoke test,
not a measurement: nobody measured frame time or long-session behavior on a device,
nor touch controls and screen rotation.

To do at the first opportunity:
- frame time on a device (via `performance.now` in the console)
- a 20+ minute session: does memory grow, does FPS degrade
- background tab and coming back (step catch-up)
- screen rotation and fullscreen

## Deliberate limitations

### 4. `provider` mode gives no shared state
Direct API polling works, but each client sees its own picture:
a window of ~300 trades does not allow replaying a shared history.
The `SYNC` badge turns yellow. Only `csv` guarantees shared state.

**Protected against accidental use:** the mode requires an explicit
`FEEDCFG.allowSolo = true`. An explicit `mode: "provider"` in `savefly.config.json` enables it by itself - previously this path was blocked, and on static hosting the game silently fell back to simulation
with a note in the console. So it does not reach prod by oversight.

### 5. A snapshot is the collector's claim
**Substantially weakened.** Snapshots form a chain: replaying the events
between two neighbors must give exactly the hash of the second. So trust
is needed only for the first snapshot, and everything after is checked by
arithmetic.

```bash
node tools/verify.js
```

```
events       : 1,600
snapshots    : 8 (steps 6000..47971)
links intact : 7 of 7
VERIFICATION PASSED - every snapshot follows from the previous one via log events
```

Tested against forgery: changing `kills` by 7 and `silk` by 30% in one
snapshot breaks exactly that link and shows immediately.

The fast path still trusts the snapshot - otherwise it would not be fast.

### 6. Logs grow on disk
**The active set is bounded.** The collector keeps the last `keepShards` (24)
shards and `keepCheckpoints` (400) snapshots, moving the rest to
`events/archive/` and `checkpoints-archive.jsonl`. They leave `meta.shards`,
so the client does not pull them.

The data does not disappear from disk - the log is append-only and verifiable,
`tools/verify.js` reads the archive too. So the disk still grows, but
it no longer affects the client or meta.

### 7. Up to 90 seconds of delay in `provider` mode
`LAG_MS` is measured at startup and capped at 90 s. With a slow
indexer the fly lags behind the chain by that much. In `csv` mode
the delay is smaller: twice the poll interval plus 8 s.

### 8. ATH lags by one bar
**Reworked.** ATH is now computed from the bar **close**, not its
high: a spike within the minute does not change the close, so it does not
become the high either. Plus a per-bar growth limit, which loosens
if bars make new highs in a row.

Checked on three scenarios:

| Scenario | ATH | Drawdown | Peak silk |
|---|---|---|---|
| Pump ×50 in 10 min | catches up | 0% | 0.000 |
| Single spike ×10⁶ | **did not move** | 0% | 0.000 |
| Real dump -70% | holds | 52% | death |

Before: a ×10⁶ spike gave 75% drawdown from a single tick.

What remains is a lag of one closed bar (up to a minute) during a fast pump.
The drawdown is 0 then, i.e. the fly is at the high - which is correct.

### 9. Epochs reset the state in demo mode
Every 6 hours. Disabled in `csv`, because genesis is fixed in `meta.json`,
so it does not affect prod.

## Minor

### 10. Dead config fields
**Removed.** `SIMC.MC0` and `SIMC.LIVE_WINDOW_MS` are deleted, the check is
automatic: no unused field in `SIMC` and `FEEDCFG`.

### 11. Poll rate
**Under control.** Instead of relying on the interval - a hard budget
`maxPollsPerMin` (7) with waiting before a request. It cannot be exceeded
even with retries after errors.

## Not started

### 12. Bytecode in a contract (phase 4)
Splitter, chunk deployment, loader, verification, gas estimate.

### 13. Operations
Token, domain, hosting, monitoring.

---

## Found by fuzzing: rounding when writing to the log

The same class as snapshot drift, but with a worse consequence.
The collector wrote to CSV via `px.toFixed(12)` and `sol.toFixed(9)`:

| Value | In the log | Error |
|---|---|---|
| `7e-13` | `1e-12` | 43% |
| `1e-15` | **`0`** | 100% |
| `sol 3e-12` | **`0`** | 100% |

For a token with a very low price - which is common with a
quadrillion supply, and even more so in SOL denomination - the log
would contain a **zero price**. The sanitizer would substitute the
ATH for it, the price would not move, silk would stay zero, and the fly would become
immortal regardless of the market.

Now we write full precision: `String(double)` in JS returns the
value exactly. Verified the round-trip number -> CSV -> parser, including
`5e-324`: zero loss.

A CSV round-trip check was added to the fuzzer, so this class of bugs
is caught automatically.

## Found by fuzzing: snapshot drift

Fixed tests check what the author anticipated. The fuzzer -
random event streams with parameters spread over 14 orders of magnitude and
invariant checks - found what nobody anticipated.

**The snapshot rounded numbers.** `snapshot()` had
`toFixed(6)` / `toFixed(9)` for compactness. Consequence:

```
shot.vx: 6.310185467955898e-9  ->  0
shot.x : 287.99999999976245    ->  288
```

Within one snapshot the hash usually matched - it quantizes. But
drift accumulated, and clients that restored from different snapshots
slowly diverged from each other and from a full replay. So the guarantee
"everyone sees the same fly" held only as long as there were few snapshots.

One failure per 400 random streams. After removing the rounding -
2,400 iterations without a single one. The cost: `state.json` grew from 720 to
838 bytes.

## Live mode was unreachable on static hosting

Found by the partner's AI, which concluded "GitHub Pages will only show the
demo, live data needs a VPS and a paid RPC". The conclusion was
logical - and wrong, because it rested on my mistake.

Live data without a server comes from `provider` mode: the browser reads trades
directly from GeckoTerminal. Verified - the API responds with
`Access-Control-Allow-Origin: *`, so a page on any domain
can call it.

But `provider` required `allowSolo: true`, and I **deliberately
prohibited** setting `allowSolo` via `savefly.config.json` - as a safeguard against
accidentally running without shared state. As a result the config set
`provider`, the game silently fell back to simulation, and it looked as if
live data was impossible without a VPS.

Along with that:

- `docs/STATUS.md` still said "paid RPC - blocker #1", although the decision
  on the free path had already been made, and the partner README said the opposite
- my archive contained `data/` with the log of **someone else's** token (PAID, 307
  events) - development test data
- there was no ready `savefly.config.json` - that is the step where everything
  broke
- on launch day the aggregator indexes the pool for ~4 minutes, and live mode,
  finding no data, fell back to simulation **forever** until a manual
  reload

Fixed:

- an explicit `mode: "provider"` in the config enables the mode by itself
- `mint` in the config - the pool is found via the mint
- badges tell the truth about every state: `live` (shared), `live · solo`
  (this viewer only), `waiting for feed`, `not configured`, `simulated`;
  in the corner `SYNC` / `LOCAL` / `SIM`
- the landing replaces the "Everyone sees the same fly" promise itself when
  the state is not shared
- `src/savefly.config.json` ships as a template, unfilled it shows
  `not configured`
- when the feed is not ready yet - `waiting for feed` and auto-retry
- `data/` is no longer packaged
- `STATUS.md`, `RUNBOOK.md`, `README.md`, `FEED.md` brought in line

Verified the partner's exact path - only the config file, the game unmodified,
the live API: pool found via the mint, badge `live · solo`.

## Chain forks: measured and closed

Reading on `confirmed` carried a risk: a block can roll back, and then
the log keeps a trade that is not on chain. The log is append-only,
it cannot be fixed.

Measured on the live chain:

| | |
|---|---|
| confirmed / finalized gap | 32 slots ≈ 12.8 s |
| Slots inspected | 2,500 |
| Vanished after confirmed | **0** (0.0000%) |
| Skipped by the network (leader) | 4 (0.16%) |

The risk is small, but one rollback corrupts the log forever, and the whole
architecture relies on it being correct. So the default is now
**`rpcCommitment: 'finalized'`**. The measured cost is 8 seconds
of extra delay (block age 12 s vs 20 s), and it fits within the
`LAG_MS` budget.

The code already survived slots skipped by the network: `getBlock` returns
a "skipped" error, and it is not treated as a failure.

## Closed by an edge case audit

**RPC source: 18 cases.** The most important - what must NOT
count as a trade: adding and removing liquidity (both deltas in
one direction), fee collection (SOL left, token did not move), failed
transactions, token-token pools without SOL. Plus: `uiAmount = null`,
missing `blockTime`, a transaction without a signature, `accountKeys`
shorter than balances (addresses from lookup tables), the pool as a signer,
duplicate signatures in two blocks, slots out of order. All pass.

**Log consistency: 5 holes, all closed.**

Changing `source` on a live log changes the price units (USD <-> SOL)
and gives a **99%** drawdown - the fly dies from a config change. Now the collector
checks `priceUnit`, `stepMs` and `pool` against `meta.json` and **refuses
to append** if they do not match:

```
LOG MISMATCH - cannot append:
  priceUnit: log SOL, config USD (source=aggregator)
```

A different `minUsd` or `source` with matching units gives a warning,
not a refusal.

`loadSeen` did not read `archive/`, so after rotation and a restart
archived signatures were outside `seen` - duplicates were possible. Now recursive.

`deaths.csv` was shared by two collectors - it duplicated death
rows. Now `deaths-A.csv` per collector.

The client stayed silent if `meta.json` had no `pool` - the seed stayed a
demo constant, and the DNA did not match the one the collector computed.
Now it writes a warning to the log.

A snapshot without new fields (from an older version) does not break the state.

## Closed after verification

- **Collector uptime.** Solved by redundancy: each collector writes
  to its own subdirectory `events/<writer>/`, the client reads all of them and
  dedupes by `sig`. No conflicts by design, no locks
  needed. Test: A runs 0-60% and 80-100% of the time, B - 40-100%;
  the merged log gives the same hash as the full one, and each alone gives
  a different one. Read order has no effect.
- **Many clients on one CDN.** 60 clients with different FPS and
  join times: 631 requests, 21.5/s, 116 KB per client, 31 shared
  checkpoints, zero divergences. The hot files are `meta.json`
  and the tail shard, both small and cacheable.
- **Collector under load.** 27,000 events/s, headroom x270.
  The bottleneck is the provider, not the collector (see item 1).
- **Two processes into one file.** `appendFileSync` gave 800 of 800 intact
  rows. But the question was resolved differently: subdirectories per collector.
- **False gaps.** Detection fired on silence. Now a gap
  is defined by the absence of overlap with the previous poll.
- **Weather lagged at startup.** The test used to pass by chance -
  on a repeat it failed (`wx=0.159` with a target of `0.859`). Added
  `snapWeather()` after sync and re-anchor.
- **Spoke vibration and `webBuzz`** - within [0,1].
- **Memory leak** - over 500k steps the heap growth is negative.
