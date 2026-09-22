# SAVEFLY — handoff

Read this before touching anything. It is written for whoever (or
whatever) is wiring the token in and building the brain module.

**Everything here has been measured on mainnet, not assumed.** Where a
number appears, it came from a real request. Where something does not
work, it says so.

---

## 0. Hosting — read this first

**Paid infrastructure is never required.** No paid RPC, no API keys.
There are two ways to run it, and the difference is one word in a
config file.

### A. Static hosting only (GitHub Pages, Netlify, Cloudflare Pages)

**Live data from the real token, zero servers, free.**

The browser reads trades directly from GeckoTerminal's public API —
verified: it returns `Access-Control-Allow-Origin: *`, so a page on
GitHub Pages can call it. Nothing runs on your side.

`src/savefly.config.json`:

```json
{
  "mode": "provider",
  "mint": "YOUR_TOKEN_MINT_ADDRESS",
  "ca":   "YOUR_TOKEN_MINT_ADDRESS"
}
```

That is the whole setup. The pool is found from the mint automatically.
Verified end to end with only this file and an unmodified game: pool
resolved from the mint, badge shows `live · solo`, drawdown and silk
tracking the real token.

**The trade-off, stated plainly:** each viewer builds the fly from the
most recent ~300 trades, so two people who opened the page at different
times can see slightly different states. The game labels this honestly
— the badge says `live · solo` and the corner hash says `LOCAL`, not
`SYNC`. There is also no necropolis (no death history), because nothing
is recording deaths between visits.

The landing page adjusts itself too: when it sees `"mode": "provider"`
in the same config, it replaces the "Everyone sees the same fly"
section with an accurate description of this setup. You do not need to
edit it.

### B. With the collector (any always-on machine)

**Everyone sees the identical fly, full history, deaths recorded.**

Needs one process running 24/7 — `node ingest/ingest.js`. A $4/month
VPS is plenty; so is a spare machine at home. It uses the same free
GeckoTerminal API, still no paid RPC. Static hosting serves the files it
writes. See sections 2–4.

`src/savefly.config.json`:

```json
{ "mode": "csv", "dataUrl": "/data/", "ca": "YOUR_TOKEN_MINT_ADDRESS" }
```

The badge shows `live`, the corner shows `SYNC`, and the landing keeps
its "Everyone sees the same fly" section — because in this setup it is
true.

### What "simulated" means

If the game shows a `simulated` badge and `SIM` in the corner, it found
no config and is running its built-in generator. Those spiders are not
real trades. **Do not ship that as the token's live page** — viewers
would take invented activity for the real market. It exists for local
development only.

### Which one

Start with **A**. It is live, free, and takes one file. Move to **B**
later if the shared state and the death history start to matter.

---

## 1. What already works

A deterministic pixel game. A fly sits in a web. Sells spawn spiders
that crawl toward her, buys fire shots that hunt the spiders down, and
the silk wrapping her is the drawdown from all-time high. Full cocoon
ends the generation and a new fly hatches with a different look.

The important property: **her state is a pure function of the trade
log**. Same events in, same fly out. There is no `Math.random` anywhere
in the simulation — verified automatically. Two browsers side by side
show the same state hash, and anyone can replay the log and check it.

| Piece | Status |
|---|---|
| Engine, economy, rendering | done, 105 functional tests + ~60k fuzz iterations |
| Trade collector (2 sources) | done |
| Shared state across clients | done, verified with 40 simultaneous clients |
| Landing page + game | done |
| Code-on-chain (Solana account) | tooling done, needs one signing session |
| Brain module | **yours** — see section 6 |
| On-chain death record | **needs a decision** — see section 7 |

---

## 2. Setup B: what to fill in for the collector

This section and the next two are only for **option B**. For option A,
section 0 is everything.

### The token

`ingest/config.json`:

```json
{
  "source": "aggregator",
  "mint": "YOUR_TOKEN_MINT_ADDRESS",
  "pool": "",
  "minUsd": 0
}
```

Leave `pool` empty. You do not need the pool address — it is derived
from the first trade automatically. See section 4 for why that matters.

### The client

Create `src/savefly.config.json` next to the game. Do **not** edit the
HTML:

```json
{
  "mode": "csv",
  "dataUrl": "/data/",
  "pollMs": 4000,
  "ca": "YOUR_TOKEN_MINT_ADDRESS"
}
```

(For option A the file is different — see section 0.)

The same file feeds the landing page: it fills in the contract address
and points the buy buttons at Jupiter.

That is the whole configuration. Everything else has working defaults.

---

## 3. Running it

```bash
npm install                  # only needed for the test suite
node ingest/ingest.js        # the collector — keep this alive
node tools/serve.js          # landing at /, game at /play
```

The collector writes an append-only CSV log into `data/`. The client
reads those files as static assets. There is no database and no API.

**If the collector stops, events are lost permanently.** The data
source only exposes the last ~300 trades, so a gap cannot be
backfilled. Use `Restart=always` — there is a systemd unit in
`deploy/`. For real redundancy run a second collector with
`"writer": "B"` on another machine; the logs merge deterministically
and duplicates are removed by signature.

---

## 4. Launch order — this part is irreversible

The log is append-only. Two things cannot be fixed after the fact.

### Start the collector BEFORE the token exists

It catches trade number one, and genesis is derived from it. Start
late and the fly was not born with the token.

You do not need the pool address in advance — which is good, because
for a pump.fun token the pool is a PDA that does not exist yet.
Point the collector at the **mint**, which you control:

```
collector [A]: mint AZsGBNoXyV... / solana
[rpc] subscribed to AZsGBNoX... (mint; pool will be found from the first trade)
[rpc] pool found via mint: J5NCBaC7hsGbJd81vM9Bm14V6Qo1xCzEhRsPYf2Z2GDy
[init] pool locked: J5NCBaC7...
```

Verified on mainnet: `logsSubscribe` accepts a well-formed address
with no account behind it yet, so you can subscribe before the pool
is created. The pool is then identified as the only account whose SOL
and token balances move in **opposite** directions — checked against a
live pump.fun pool and it matched exactly.

### Set `minUsd` before the first event

It is a provider-side dust filter. Changing it later means different
filtering in different parts of one log (the collector warns but does
not stop you).

Measured on a real fresh launch — LaunchThis, 300 trades in its first
8 minutes, median trade $21:

| minUsd | trades kept |
|---|---|
| **0** | **100%** |
| 3 | 82% |
| 10 | 68% |
| 50 | 31% |

**Use 0 for a launch.** A threshold only makes sense on an established
token where dust genuinely crowds out the provider's window.

---

## 5. Data sources, and the free-tier reality

Paid infrastructure is not required. Here is what actually happens
without it.

### `source: "aggregator"` — use this

Public GeckoTerminal API, no key. The collector holds itself to 7
polls per minute, well under the limit.

Measured limits:

- **300 trades per request, no pagination.** Verified: `limit`, `page`
  and `cursor` all return the same 300. So the hard ceiling is
  `300 / poll interval` = about **2,250 trades per minute** at the
  default 8-second poll.
- **A new pool appears in the index after about 4 minutes.** But the
  300-trade window usually reaches back further than that, so at up to
  roughly 75 trades/min you still capture trade number one. Above that
  you will lose the opening minutes.
- Above the ceiling, events are lost and it is visible: the `gaps`
  counter in `meta.json` goes up, and the collector logs it.

For a project that is meant to be fun, this is fine — as long as
nobody claims the log is complete when `gaps > 0`.

### `source: "rpc"` — optional, needs a paid endpoint

Reads Solana directly, no ceiling: `logsSubscribe` finds slots with
pool activity, `getBlock` returns every trade in them. About 150
requests per minute regardless of trade rate — tested at 10,000 and
30,000 trades/min with plenty of headroom.

**It does not work on the public RPC.** Measured:

- `getBlock` at the required rate: **8% success, 66 throttles out of
  73 requests**
- per-transaction mode, batch reduced to 20: **561 throttles in 60
  seconds, 1 trade captured**

So: aggregator now, and keep `rpc` in your pocket for when the token
is busy enough to justify paying for an endpoint. Switching later
needs a **new log directory** — the price unit differs (USD vs SOL)
and the collector will refuse to mix them.

---

## 6. Where the brain module plugs in

This is the part you are building. One integration point, one hard
rule.

### The integration point

`moodOf()` in `src/savefly.html` returns
`[label, colour, stateKey]`. `stateKey` selects a target pose from the
`FACE` table, and `updFly()` eases the fly's features toward it.

Replace `moodOf()`, or override the target it produces. Everything it
reads is already available to you:

| Input | Meaning |
|---|---|
| `nearestSpiderDist()` | distance from the closest spider, in pixels |
| `outFlow` / `inFlow` | recent sell and buy pressure, 0..3 |
| `silk` | how wrapped she is, 0..1 |
| `S.spiders` | live spiders with size, spoke and position |
| `dead` | whether the generation is over |

The features you can drive are in `FKEYS`: `glint`, `anten`, `prob`,
`flutter`, `struggle`, `curl`, `tilt`, `bright`. Look at the `FACE`
table for the ranges each one uses.

### The hard rule

**The brain must not touch simulation state.**

`moodOf()` is render-only today, and that is deliberate. It is called
from `updFly`, `drawFly`, `ui` and the music layer — never from
`simStep` or `simApplyEvent`, which has been verified.

If a brain module writes back into `S` — silk, spiders, counters,
anything — then every viewer's fly diverges, the state hash stops
matching, and the one genuinely interesting property of this project
is gone. Read from the simulation freely. Do not write to it.

Anything non-deterministic (a spiking model, a timing-dependent
network, sampled noise) is fine **on the render side only**. The test
`test/shared-state.test.js` will catch a violation: run it after
wiring anything in.

```bash
node tools/serve.js &
node test/shared-state.test.js     # must stay PASS
node test/determinism.test.js      # must stay PASS
```

### What the landing page currently promises

There is a section on the connectome. It says the module is **in
development**, names the circuit family (the giant-fiber escape
pathway), and states plainly that a connectome is a wiring map and not
a mind. Please keep it aligned with reality: if the shipped module
uses different circuits, change the copy.

---

## 7. Deaths, and the one open decision

Every death is written to `data/deaths-A.csv` with the signature of the
last trade before it, so each entry is anchored to a real transaction
and can be confirmed by replaying the log. The game reads this file and
shows past generations.

**This is a verifiable registry. It is not a contract.** It sits on our
disk and we could rewrite it.

Three options with costs and trade-offs are written up in
`docs/ONCHAIN-DEATH.md`. Short version: option A (a keeper wallet
signing each death) costs under 0.01 SOL a month and can ship in a day;
option C (anyone can submit the death, contract accepts the first valid
one) is the only one where "nobody has to trust us" is literally true.

Until one of them ships, **do not write "recorded on-chain forever"**
anywhere.

---

## 8. Code on chain — optional, cheap, after launch

The game can live in a Solana account and be verified by hash.

```bash
node onchain/write.js               # builds payload, prints the plan
node onchain/verify.js <address>    # reads it back, compares hashes
onchain/loader.html                 # reads the account and runs the game
```

Measured: 118 KB of HTML compresses to **36 KB with brotli**, rent
deposit **0.19 SOL and refundable**, 42 write transactions at
0.000005 SOL each. Unlike EVM there is no 24 KB contract limit to work
around — a Solana account holds up to 10 MB, so it is one account and
no chunking. The whole chain was verified locally: payload → header →
sha256 → decompress → byte-for-byte identical → game runs.

Do this whenever you like. The code does not change after launch, so it
is not a blocker.

---

## 9. Verify anything

```bash
node tools/replay.js       # replay the log from genesis, print state hash
node tools/verify.js       # check the snapshot chain links up
node tools/monitor.js data # health: gaps, staleness, stalled sim (exit 1 on problems)
node tools/headers-check.js https://your.site
```

The hash from `replay.js` must equal `meta.json` → `simHash`,
`state.json` → `hash`, and what the game shows in its corner. If they
ever disagree, that is a real bug and worth shouting about.

Tests:

```bash
npm test                   # 105 functional tests
npm run test:fuzz          # random event streams against the invariants
npm run test:shared        # multiple clients converge (needs serve.js)
```

---

## 10. Claims — what holds up and what does not

The verifiability is the whole pitch. It only works if the rest of the
copy is clean.

**True, and worth saying loudly:**

- Sells spawn spiders, buys shoot them down, silk is the drawdown
- Every viewer sees the same fly, and the state hash proves it
  (**option B only** — with option A each viewer's state is local)
- The state is derived from the chain, and anyone can replay it
- Her name and appearance are derived from the pool address
- The code can live in a Solana account and be verified by hash
- The full fly connectome is real, complete and public — 139,255
  neurons, over 50 million synapses, in Nature, October 2024

**Do not say:**

- that she feels, experiences, or suffers anything
- that a brain is running, until one actually is
- "no server, no backend, delete the site and it lives forever" — a
  loader has to be hosted somewhere and an RPC node has to answer
- "death recorded on-chain forever" — not until section 7 is resolved
- that the log is complete when `meta.json` → `gaps` is above zero

The first technically-minded person who looks will check these. The
project survives that inspection today. Keep it that way.

---

## Map of the repo

```
src/index.html        landing page
src/savefly.html      the game
src/og.png            share image
ingest/ingest.js      collector
ingest/rpc-source.js  direct Solana reader
tools/                replay, verify, monitor, profiling, share images
onchain/              write / verify / loader for code-on-chain
deploy/               systemd units, nginx and CDN header configs
docs/STATUS.md        start here — index of everything else
docs/RUNBOOK.md       deployment and what to do when it breaks
test/                 20 test files
```
