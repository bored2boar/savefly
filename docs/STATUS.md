# Status

The single entry point. The other documents are details:

| File | About |
|---|---|
| `RUNBOOK.md` | deployment, config, what to do when something breaks |
| `ARCHITECTURE.md` | SIM/RENDER, time, epochs, the pixel layer |
| `ECONOMY.md` | constants, volume-based spawning, fresh launch mode |
| `FEED.md` | event sources, the ceiling, parsing trades from pool deltas |
| `STORAGE.md` | CSV, snapshots, rotation, advance limit |
| `TESTPLAN.md` | test plan, results, the fuzzer |
| `KNOWN-ISSUES.md` | known issues and what is already closed |
| `ONCHAIN-DEATH.md` | options for recording deaths on chain |
| `ONCHAIN-CODE.md` | game code in a Solana account: cost, format, tools |


Version 1.5.0. Snapshot date: 2026-09-19.

## Done

| Block | State |
|---|---|
| Deterministic engine | state = function of (seed, log, step); no `Math.random` in the simulation |
| Shared state | verified on 4 and on 40 clients, zero divergences |
| Snapshots | the chain is checked by arithmetic, trust only in the first one |
| Storage | CSV, append-only, served as static files, rotation and archive |
| Source: aggregator | ceiling ~3,400 significant trades/min |
| Source: direct RPC | **10,000+ trades/min**, but only with a paid endpoint - optional |
| Collector redundancy | a subdirectory per collector, no conflicts by design |
| Death registry | `deaths-A.csv`, every row tied to a transaction signature |
| Economics | the response to imbalance is the same at 300…30,000 trades/min |
| Fresh launch mode | verified on live pump.fun tokens |
| Rendering | Uint32 buffer, frame 0.74…2.27 ms |
| Mobile browsers | on-device smoke test passed; `?perf=1` for measurements |
| Necropolis | the client reads the death registry, shows dead generations |
| Config without editing HTML | URL parameters or `savefly.config.json` |
| Sharing | og/twitter tags, `og.png` rendered by the engine |

## Verification

| | |
|---|---|
| Functional tests | **105 pass, 0 fail** (10 files) |
| Fuzzing | **~59,000** random streams, 0 failures after fixes |
| Found by the fuzzer | 2 bugs, both precision loss during serialization |
| Snapshot chain | intact |
| Three hash sources | match |
| Dead code | none |

## Blocking launch

Nothing in the code. A paid RPC is **not needed** in either setup.

Two ways to deploy:

- **Static hosting only** (GitHub Pages etc.) - `mode: provider`
  in `savefly.config.json`. Live data from the token, zero servers.
  Each viewer has their own state (badge `live · solo`), no necropolis.
- **With the collector** on any 24/7 machine - `mode: csv`. Shared
  state, history, death registry.

Details - `README-PARTNER.md`, section 0. For the collector setup
the operational part remains (`RUNBOOK.md`):

2. **Collector hosting** with auto-restart, preferably two (`writer: A` / `B`)
3. **Cache headers** - `meta.json` must be `no-cache`, otherwise a CDN caches the head and clients will not see new shards
4. **CORS** with `Access-Control-Expose-Headers: Content-Range`, if the data is on another domain
5. **Domain**
6. **Alerts** on `gaps` and the age of `updated`

The order at launch is critical: **the collector goes up BEFORE the token is created**, because it catches trade #1, and the DNA of the first generation is derived from it.

## Open question for the partner

Who signs deaths on chain and pays gas. Three options with
trade-offs, a gas estimate and acceptable wording -
`ONCHAIN-DEATH.md`. In short: option A (keeper wallet) takes
a day and already gives an on-chain record with a verifiable hash; option C
(any viewer writes) makes the claim unconditional, but it is a
separate project.

Until there is a decision, `deaths-A.csv` is an honest verifiable registry,
but **not a contract record**, and the wording "the death is recorded on
chain forever" must not be used.

## Deliberate limitations

- a hot pump above ~30,000 trades/min will hit traffic limits, not code limits
- a snapshot is the collector's claim; the fast start trusts it, the verification path is optional (`tools/verify.js`)
- ATH lags by one closed bar during a fast pump (the drawdown is 0 then, which is correct)
- logs grow on disk; the active set is bounded, the archive stays

## Game code on chain

The tools are ready and verified locally: `onchain/write.js`
prepares the payload (36 KB brotli, 0.19 SOL deposit, 42 transactions),
`onchain/verify.js` checks the hash, `onchain/loader.html` reads the account
in the browser and runs it. The chain was verified byte for byte.

What is left: sign 42 transactions with a real key. Do not block
the launch on this - the code does not change, it can be put on chain any time.
Details and the limits of the claim - `ONCHAIN-CODE.md`.
