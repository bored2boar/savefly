# Runbook

Everything done by hand at launch and during operation.

## Before launch: check the RPC

Not by the marketing, but by what we need: 150 heavy
`getBlock` calls per minute on `finalized`.

```bash
node tools/rpc-check.js https://your-endpoint 45
```

The public RPC for comparison: **8% success, 66 throttles
out of 73 requests**. Not suitable.

The `SUITABLE` verdict also shows the traffic budget - about 30 MB/min
at full slot coverage, less on a quiet token.

## Deployment

```bash
# 1. code
sudo mkdir -p /opt/savefly /var/log/savefly
sudo useradd -r -s /bin/false savefly
sudo rsync -a --exclude node_modules ./ /opt/savefly/
sudo chown -R savefly:savefly /opt/savefly/data /var/log/savefly

# 2. config
sudo -u savefly vim /opt/savefly/ingest/config.json
#   pool          - pool address
#   source        - 'aggregator' (free, default); 'rpc' - only with a paid endpoint
#   rpcHttp       - only if source:'rpc' (optional, needs a paid endpoint)
#   writer        - 'A' (on a second machine 'B')

# 3. collector
sudo cp deploy/savefly-ingest.service /etc/systemd/system/savefly-a.service
sudo systemctl enable --now savefly-a

# 4. monitoring
sudo cp deploy/savefly-monitor.service /etc/systemd/system/
sudo systemctl enable --now savefly-monitor

# 5. serving
sudo cp deploy/nginx.conf /etc/nginx/sites-available/savefly
sudo ln -s /etc/nginx/sites-available/savefly /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 6. client - no need to edit the HTML
cat > /opt/savefly/src/savefly.config.json <<'JSON'
{ "mode": "csv", "dataUrl": "/data/", "pollMs": 4000,
  "ca": "TOKEN_ADDRESS" }
JSON
#   the landing reads the same file: it fills in the CA and the buy links
```

## Config without editing the HTML

Editing 100 KB of HTML during deployment is the most fragile point
in the process. So there are two ways, in priority order:

```
1. URL parameters      ?mode=csv&dataUrl=/data/&pollMs=3000
2. savefly.config.json next to the page:
   { "mode": "csv", "dataUrl": "/data/", "pollMs": 4000 }
```

Only known keys are allowed: `mode`, `dataUrl`, `pollMs`,
`network`, `pool`, `staleMs`. A foreign file **cannot** enable
`allowSolo` - the mode without shared state stays available only
by editing the file itself.

The console shows what was applied:
```
[savefly] config: mode=csv (config), dataUrl=/data/ (config)
```

## On-device measurements

```
https://savefly.example/?perf=1
```

The corner overlay shows frame time, p95, FPS, entity count,
silk, step and memory used where the browser exposes it.
Needed to measure on a phone without a console attached.

What to capture:
- frame time when calm and in a storm (silk > 0.7)
- a 20+ minute session: does the heap grow, does FPS degrade
- background tab and coming back: how many steps it catches up
- screen rotation and fullscreen

## What lives where

```
src/index.html      landing (also the site root)
src/savefly.html    the game
src/og.png          share image
src/savefly.config.json   config for both
data/               the log
```

The landing links to the game as `savefly.html` in the same directory.
If the game lives elsewhere - `?game=/path`. The token address comes from
`savefly.config.json` -> `ca`, or from `?ca=...`.

## Right after: check the headers

```bash
node tools/headers-check.js https://savefly.example
```

Two things here break the game silently:

- **`meta.json` is cached** - the client will not see shard rotation
  and will lose the live feed, without any error
- **no `Content-Range` in `Access-Control-Expose-Headers`** -
  the browser cannot see the header, Range resumption fails, the client
  pulls the whole tail shard every time

Neither is visible from the server side - only via this check.

## Order at the moment the token is created

There are two things here that **cannot be redone after the start**.

### 1. The collector goes up BEFORE the token is created

It catches trade number one - genesis is derived from it. Starting
later means a fake genesis: the fly will not be born together with the
token, and this cannot be fixed, because the log is append-only.

**You do not need to know the pool address.** The mint address is enough - i.e. the
token you create yourself. Verified: `logsSubscribe` works on
a valid address with no account, so you can subscribe before the pool
exists. The pool is found from the very first trade: it is the only owner whose
SOL and token move in opposite directions.

```json
{ "source": "rpc", "mint": "TOKEN_ADDRESS", "pool": "" }
```

```
collector [A]: mint AZsGBNoXyV... / solana
[rpc] subscribed to AZsGBNoX... (mint; pool will be found from the first trade)
[rpc] pool found via mint: J5NCBaC7hsGbJd81vM9Bm14V6Qo1xCzEhRsPYf2Z2GDy
[init] pool locked: J5NCBaC7...
```

The DNA seed of the first generation is derived from the locked pool.

### 2. minUsd must be set BEFORE the first event

With `source: 'aggregator'` the dust filter is handed to the provider, and
changing it later means different filtering in different parts of the
log (the collector will warn, but not stop).

Measured on a real fresh launch (LaunchThis, 300 trades in its
first 8 minutes, median volume $21):

| minUsd | Trades kept |
|---|---|
| **$0** | **100%** |
| $3 | 82% |
| $10 | **68%** |
| $50 | 31% |

So for a launch use **`minUsd: 0`**. A threshold only makes sense on an
established token, where dust really crowds out the provider's window.
With `source: 'rpc'` it is not used at all.

## Checking that everything matches

```bash
node tools/replay.js     # independent log replay
node tools/verify.js     # snapshot chain
node tools/monitor.js data
```

The hash from `replay.js` must match `meta.json` -> `simHash`,
`state.json` -> `hash` and what the game shows in the corner
(`SYNC <hash> @<step>`).

## What to do when

### Monitoring shouts "collector silent"
```bash
sudo systemctl status savefly-a
sudo tail -50 /var/log/savefly/ingest-a.log
```
Downtime = lost events, and they cannot be recovered. Hence Restart=always
and RestartSec=2. If it crashes in a loop - look at the RPC
(`rpc-check.js`) and at the limits.

### gaps went up
Events during that time are lost forever - the provider only serves
the last ~300 trades (aggregator) or the block is already outside the window (rpc).
It cannot be fixed. Actions: find the cause of the downtime and bring up
a second collector (`writer: B`) on another machine, so that next time
it covers the hole.

### Snapshots are lagging
`ckStep` is far from `simStep` - the cold start will be slow.
Rebuild:
```bash
node tools/checkpoint.js
```

### Need to change source or stepMs
**You cannot append to the existing log.** The collector will refuse:
```
LOG MISMATCH - cannot append:
  priceUnit: log SOL, config USD
```
Changing price units gives a 99% drawdown and kills the fly. Either restore
the config, or start a new log in a different `dataDir`.

### Disk keeps growing
The active set is bounded (`keepShards`, `keepCheckpoints`), the rest
is in `archive/`. The archive can be moved to cold storage - `verify.js`
reads it, but the client does not need it.

## What NOT to do

- do not run two collectors with different `minUsd` or `source` into one
  directory: the units will match, the filtering will not
- do not set `FEEDCFG.mode = 'provider'` in prod: it gives no
  shared state, each client has its own picture. That is exactly why the mode
  requires an explicit `allowSolo: true`
- do not delete shards by hand: the log is append-only and verifiable,
  deleting breaks the snapshot chain
