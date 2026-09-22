# Storage

A primitive DB: append-only text plus a materialized head.
No database server, served as static files.

```
data/
  events/2026-09-19T10.csv      trade log, hourly shards capped at 4 MB
  events/2026-09-19T10.1.csv    continuation if the hour outgrew the cap
  checkpoints.jsonl             state snapshot log (append-only)
  state.json                    latest snapshot - this is what the client reads
  meta.json                     genesis, ATH, list of shards, gaps
```

## Why sharding alone is not enough

A tempting idea: cut the log into chunks and fetch the archive "only on
demand". It does not work.

The state "now" is a function of **all** events since genesis. Without reading
the archive you do not know the silk, the generation, the ATH, or how many times
she has died. The archive is always needed, not on demand.

Sharding only solves serving: files are smaller, cacheable, a closed shard is
immutable. That is useful, but it does not remove 30 seconds of CPU for a
week-long log.

## State snapshots

A snapshot is the full simulation state, including spiders and shots in
flight. Without the entities the restore would diverge.

```json
{"step":12090000,"gen":3,"px":0.0312,"pxAth":0.0378,"debt":0.019,
 "silk":0.203,"kills":153572,"bites":2103,
 "spiders":[[891,7,0.42,0.43,1.2,0.8,0.0019,3.1,12.4,19,0]],
 "shots":[["f",902,240,96,238,96,1.1,0,0.6,12],["p",4,0.3]],
 "hash":"9c19fb76"}
```

About 2-4 KB. Written every `ckSteps` (default 6000 = 5 min).

**Verified:** restoring from a snapshot gives a bit-identical state to a
full replay from genesis. The hash matches.

`checkpoints.jsonl` grows forever and is only needed for verification and
archiving. The client reads `state.json` - a single head of a few kilobytes.

## What the client does at startup

1. `state.json` - the latest snapshot
2. restores the state
3. `meta.json` - the list of shards
4. pulls only the last 3 shards and filters events from the snapshot step on
5. replays the tail, usually a few thousand steps

Result on a week-long log: **503 KB, 5 requests, 0.53 s**
versus 32 MB and ~50 s without snapshots.

## Advance limit

If the log falls behind - the collector died or the provider went silent - the client
does not run the simulation into the void. Advancing is capped at the last known
event plus `STALL_GRACE` (1200 steps = 60 s).

Without this limit a client on a stale log replayed 4.2M empty
steps. Found by measurement, not by reasoning.

## Shard size

The hour is the natural key, but on a hot launch an hour can produce
tens of MB and break resumption. So the shard is split into `.1`, `.2` when
it reaches `shardMaxMB` (4 MB by default).

## Rebuilding snapshots

If the log exists but there are no snapshots:

```bash
node tools/checkpoint.js
```

Runs through the log, writes `checkpoints.jsonl`, `state.json` and updates
`meta.json`.

## Verification

```bash
node tools/replay.js      # full replay from genesis
```

The hash must match `state.json` and what the game shows.
The fast path trusts the snapshot, the verification path does not.
