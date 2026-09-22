# Feed

## Event format

```js
{ ts, side: +1|-1, sol, px, blk, sig }
```

Canonical order: step by `ts`, within a step `blk`, then `sig`.
The signature as a tie-break makes the order unambiguous.

## Sources

`ingest/config.json` -> `source`:

| Source | Ceiling | Requests at 10k trades/min |
|---|---|---|
| `aggregator` | ~3400 significant trades/min | unreachable |
| `rpc` (getBlock by slot) | **none** | **150/min** |

### Why the aggregator has a ceiling
It serves 300 trades per request, with no pagination - verified `limit`,
`page`, `cursor`, all return the same 300. So the ceiling =
`300 / poll interval`, and above it data is lost for good.

### Direct RPC
`logsSubscribe` on the pool gives the slot numbers with activity (push, no
polling). `getBlock` with `transactionDetails: 'accounts'` returns
**all** trades in the slot together with token balances. The cost is one
request per slot, i.e. it **does not depend on the trade rate**.

Measured on the live chain:
- 1071 transactions in a block, 246 ms, 3.25 MB
- 93 swaps network-wide from one block
- 10,050 trades/min for 150 requests/min, headroom x469

Amounts come from the deltas of the **pool's own accounts**:

```
pool gave SOL, received token -> sell
pool received SOL, gave token -> buy
```

The SOL side sits in different places depending on the AMM, and this matters:

- **Raydium and similar** keep WSOL in the pool's token account;
- **pump.fun AMM** keeps SOL as **native lamports** in the pool
  account itself - they have no WSOL account at all.

So we take the sum of both. Without the native part pump pools gave zero
trades, even though the pool was working: found on a live token, not by analysis.
Checked against five pump pool trades (large, small, buy and sell):
divergence **0.000%**.

Works for any AMM without decoding instructions, and stays
clean even in swaps routed through several pools.
Checked against the aggregator on a real trade: divergence **0.1%** -
that is the LP fee (the aggregator reports the trader's amount, we report the pool delta).

Price is in **SOL per token**, not USD. Silk is a ratio to ATH,
so units do not matter, and the dependence on the SOL/USD rate disappears.

The noise filter is self-learning. Auto-detecting a single AMM does not work:
swaps are routed through several, and a guessed "main" program
cut off all trades. So the set is built from programs that have already
produced recognized trades - it picked up pump AMM, Raydium, Meteora,
Jupiter on its own.

### Commitment level
Default is `finalized`. On `confirmed` a block can roll back, and a trade
that is not on chain would stay in the append-only log forever.
Measured: a gap of 32 slots (12.8 s), over 2500 slots 0 blocks vanished,
but the cost of the insurance is only 8 seconds of delay.

**The public RPC throttles `getBlock`** (181 rejections per run).
This mode needs a paid endpoint: 150 requests/min is
trivial for any plan, traffic ~30 MB/min at full
slot coverage, on a quiet token - a few requests per minute.

## Aggregator modes

### demo (internal name: simulation)
A built-in deterministic trade generator. Turns on only when there is
no config. The viewer sees a `simulated` badge and `SIM` in the corner,
so invented activity is not mistaken for real. Development only.

### provider
Polling a public API directly. Works, but:

- **limits**: 20 polls in two minutes get the IP blocked. Not every browser
  can poll the provider
- **window**: the endpoint serves the ~300 most recent trades, i.e. a few minutes.
  Replaying a six-hour epoch is impossible

Consequence: the picture is correct, but **each viewer has their own**. The `SYNC` badge
turns yellow.

### csv
A static log written by the collector. Everyone reads the same files,
so one event stream and one hash. Served by any CDN.

The tail of the current hour is fetched with a Range request - only the
increment is pulled. If the server does not support Range, the client trims what it already read itself.

## Seeding the ATH

The all-time high is taken from daily OHLCV candles. Without this the fly
on an already fallen token would start with zero silk instead of the real value.

Example: PAID, ATH 0.0378, current 0.0300 - the fly starts with silk 0.22.

The collector keeps `athSeeded` and retries until it succeeds: an understated
ATH would give zero drawdown.

## Delay

The provider indexes with a delay. It is **measured at startup**:

```js
LAG_MS = min(90000, indexLag + pollMs*2 + 4000)
```

In a production run it came out to 43 seconds.

Events that are late within `LATE_GRACE` (1200 steps) are clamped
to the current step instead of being lost. In `csv` mode clamping
is off - there the source guarantees the order.

Loss at different provider delays (test on real trades):

| Delay | LAG (auto) | Lost |
|---|---|---|
| 5 s | 17 s | 2.7% |
| 20 s | 32 s | 2.4% |
| 45 s | 57 s | 2.4% |
| 90 s | 90 s (cap) | 8.3% |
| 180 s | 90 s (cap) | 19.7% |

## Startup order

Important: **fetch the trades first, then set genesis**.

An early version set genesis at `now - 8 min` and only then pulled the data.
The simulation had to burn through artificial debt, and while it did, fresh
events arrived stamped in the past: 354 of 377 events were dropped.

After the fix - zero late events.

## Degradation

If polls stop going through, the badge becomes `feed stalled`. The simulation
does not freeze: spiders finish crawling, shots finish flying, there are just no
new events.

If the live start fails, the game falls back to demo mode with a matching
badge, instead of showing a dead screen.
