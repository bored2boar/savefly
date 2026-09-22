# Economics

The constants were tuned by runs on live Solana trades, not by eye.

## Silk

```
silk = (1 - price / price ATH) + debt for bites
```

The chain gives the drawdown. The game only adds a debt for the spiders that got through,
and that slowly heals.

The price is **not simulated**. An early version subtracted a notional market cap
for every sell - on real data this killed healthy tokens within
eight minutes and missed real dumps.

## Amount mapping

Real trades span five orders of magnitude: from 0.00003 to 28 SOL.

```js
size = clamp(log2(1 + sol/SIZE_REF) * SIZE_K + 0.22, 0.20, 3.0)
```

Trades smaller than `DUST_SOL` spawn no entity, they only move the price.
Without this filter a token with micro-trades gives 250 spiders in 5 minutes.

## Volume-based spawning

Entities are born at a **volume threshold**, not on every trade.
The threshold is adaptive: it equals the volume over `SPAWN_STEPS` steps of flow.

```
thr   = max(SIZE_REF, flow * SPAWN_STEPS)
evVol = max(thr, sol)          // one entity = the volume of this trade
```

This gives two modes without any switches:

- **quiet token** - the threshold drops to `SIZE_REF`, and every trade above
  it gives one entity whose size matches its own
  volume. A 2 SOL trade = one spider of size 2.34, not six
  small ones.
- **hot token** - the threshold is large, small trades accumulate,
  the entity represents an aggregate.

Without this, at 10,000 trades/min the cap of 12 spiders saturated: every
sell merged into the largest one, which accumulated infinite hp,
became unkillable and bit nonstop. The result was silk 1.03 and
12 deaths at **zero** price drawdown.

The number of spawns from one event is capped by `SPAWN_MAX`. Without this
an event of 1e9 SOL produced 3.3 billion iterations and the process hung - found
by a hanging test, not by analysis.

### The response does not depend on the rate

Price is flat, to see only the defense:

| Sells | 300/min | 3000/min | 10000/min | 30000/min |
|---|---|---|---|---|
| 47% | 100% / 0.00 | 100% / 0.00 | 100% / 0.00 | 100% / 0.00 |
| 60% | 83% / 0.48 | 80% / 0.52 | 75% / 0.61 | 76% / 0.54 |
| 75% | 100% / 1.02 | 40% / 1.02 | 32% / 1.02 | 50% / 1.01 |
| 90% | 8% / 1.02 | 3% / 1.02 | 0% / 1.02 | 5% / 1.02 |

(intercept / peak silk). Deaths: 0 at 47-60%, 5-7 at 75-90% -
the same at all rates. ~290-430 spawns regardless of rate.

## Fresh launch mode
## Why it is a separate mode

A memecoin in the first minutes of its life behaves unlike anything else.
Real data from five random launches aged 2 minutes:

| Token | Change over 5 min | Price range |
|---|---|---|
| wildebeest | +1838% | ×4670 |
| Equitty | +114% | ×3.4 |
| armored | -60% | ×25.8 |
| Doge | -37% | - |
| frug | +12% | ×1.7 |

Before the fixes, two of the five drove the fly to silk 0.92-0.96, i.e. to the edge
of death, within the first three minutes. She would die on almost every launch,
and death would stop meaning anything.

## Three mechanisms

**ATH from closed one-minute bars, not from ticks.** A spike from a single
trade or a sandwich no longer becomes the high the drawdown
is measured from.

```
ATH_BAR_MS = 60000
```

**The drawdown contribution is capped.** A price crash alone does not kill -
the defense must fail too, i.e. bites must get through.

```
DD_CAP = 0.88
```

**Ramp-up at birth.** For the first 15 minutes the drawdown contribution ramps
from 25% to full: price discovery is not a drawdown.

```
BIRTH_GRACE = 900000
```

## Result

Fresh launches, peak silk before and after:

| Token | Before | After |
|---|---|---|
| armored | 0.96 | **0.32** |
| wildebeest | 0.92 | **0.24** |
| Equitty | 0.53 | **0.20** |

Death on a real rug is preserved: `rug -85%` and `rug -97%` still
kill. Healthy tokens are unaffected (PAID 0.48 → 0.47).

## Order of operations

**The collector must be started BEFORE the token launches.**

The pool does not appear in the provider's index right away, and genesis must be
the real first trade. The collector now waits for the pool to appear and catches trade
number one:

```
[wait] pool not indexed yet, waiting for launch
[init] genesis=2026-09-19T10:00:33.000Z
[init] pxAth=0.024676119801 (from daily candles)
```

If you start after the launch, the provider will only serve the last ~300
trades, and genesis will be fake - the fly will not be born together with the token.

## Log gaps cannot be repaired

The provider only serves the last ~300 trades. What was missed cannot be recovered.
On a token with 40 trades/min, 10 minutes of collector downtime = 400 lost
trades, and there is no way to close that hole.

The collector records gaps explicitly:

```
[gap] no overlap with the previous poll, 47s of log lost (served 300 trades)
```

The number of gaps is written to `meta.json`. So the collector must run
without downtime - this is not a wish, it is a correctness requirement.

Ways to reduce the risk:
- two collectors on different machines into the same directory
- a provider with historical queries (then the hole can be filled)

## Constants

```
SIZE_REF    0.30 SOL    reference point
SIZE_K      0.72
DUST_SOL    0.02 SOL    dust threshold
SPAWN_STEPS 24          flow steps per entity
SPAWN_MAX   6           max entities from one event
FLOW_EMA    0.02        flow smoothing (per step)
SPIDER_CAP  12          beyond this, merge into the largest
SHOT_CAP    40          max shots in reserve
SHOT_MULT   2.5         shots per unit of buy size
SPIDER_SPD  0.50
BITE_DEBT   0.035
DEBT_HEAL   0.99955     debt half-life ≈ 77 s
```

## Three fixed balance bugs

**Debt grew linearly with size.** A single whale sell that got through
cost 10.5% silk. A token that grew 7.8% in an hour died
at 90% intercept. Flattened to `0.55 + 0.45·size/3`.

**The game counted entities, not money.** A token had 67 buys versus
233 sells by count, but the buy volume was larger (484 vs
368 SOL) and the price was rising. It looked like a massacre. Fixed via
`SHOT_MULT`: a big buy gives up to 8 shots.

**Shots faded after 7 seconds** without a target. A buy in a quiet minute
was wasted. Now they wait and line up on a circle around the
web - the reserve reads as a defense. `SHOT_CAP` was needed,
otherwise the reserve grew forever (1839 kills to 9 bites).

## Verification on live data

Ten Solana tokens, zero deaths, peak silk at most 0.66.

Pearson(price drawdown, silk) = **+0.71**.

Intercept self-regulates without hardcoding:

| Scenario | Drawdown | Intercept | Silk | Death |
|---|---|---|---|---|
| pump +200% | 0% | 100% | 0.00 | 0 |
| healthy token | 2% | 80% | 0.05 | 0 |
| real drawdown | 30% | 73% | 0.30 | 0 |
| dump -65% | 65% | 57% | 0.69 | 0 |
| rug -85% | 41% | 43% | 1.02 | 1 |
| rug -97% | 66% | 16% | 1.03 | 2 |

Nobody programmed the dependence of intercept on market direction - it
falls out of the rule "buys make shots, sells make spiders".
