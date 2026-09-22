# Architecture

## Separating SIM and RENDER

This is the main line in the code. Crossing it means diverging states.

**SIM** - everything that affects the fly's fate: price, ATH, silk, debt, spiders,
shots, generations. Fixed 50 ms step. No `Math.random`,
no `performance.now`, no dependence on frame rate.

**RENDER** - cosmetics: blinking, saccades, tremor, rain, lightning,
clouds, particles, leg debris. `Math.random` is allowed here, because it does not
affect the state.

The simulation draws nothing and plays no sound. It puts events into `OUTQ`,
and the renderer plays them out. During history replay the queue is dropped.

## Randomness

```js
srnd(seed, step, purpose) -> [0,1)
```

A hash-based generator, not a sequential one. The key includes the purpose, so
adding a new draw in one subsystem does not disturb the others.

Careful: in JS the `^` operator returns a **signed** 32-bit number.
Every XOR in the hash is closed with `>>>0`. Without this the generator returns
negative values, and every trade reads as a buy.

## Time

- `STEP_MS = 50` - simulation step (20 Hz)
- `LAG_MS` - how far the simulation runs behind real time
- The renderer interpolates positions between steps (`sT`, `sX`, `sY`)

`targetStep(now) = (now - LAG_MS - GENESIS_TS) / STEP_MS`

The wall clock only decides how many steps to catch up, not how fast.

For `provider`, `LAG_MS` is measured at startup: the difference between the newest
trade and the current time. In a production run it came out to about 43 seconds.

## Checkpoints

Every 20 steps the state hash is computed and put into `S.ckLog` (the last 64).
This has two effects:

- the HUD shows `SYNC <hash> @<step>` - compared by eye
- two clients can match their logs on **shared** steps,
  even if one lags behind

Comparing the latest hashes is wrong: a client that joined later
is legitimately a few steps behind.

## Epochs

In demo mode the state is re-anchored at the boundary of a six-hour epoch.
Otherwise a long session would diverge from a new client starting from the
next boundary.

The re-anchor lives in `simCatchUp` - the single point where state advances. If
you put it in the render loop, it will not fire for those who jump
through `simCatchUp` directly.

In `csv` mode epochs are disabled: there genesis is fixed in `meta.json`.

**This is temporary.** Checkpoints will remove the state reset - `epochStep()`
will be replaced by `checkpoint.step`, `simGenesis()` by `checkpoint.state`.

## Cold start

The client replays the log from the epoch boundary to the current step. Budget of
10 ms per frame, a `REPLAYING SHARED STATE` screen with progress is shown.

Measured: 426,000 steps in 1.25 s (118 frames).

If the client falls behind by more than 200 steps, it goes back into
sync mode. Without this safeguard a slow device would lag behind
forever.

## Rendering

320×224, fixed palette, upscaled via CSS `image-rendering: pixelated`.

**We draw into our own `Uint32Array` buffer and hand it over with one
`putImageData` per frame.** It used to be hundreds of small `fillRect`s;
measured x16 difference on 2000 segments.

```
fillRect with color change   : 1.508 ms
fillRect without color change: 1.108 ms
Uint32 buffer + putImageData : 0.093 ms
```

Primitive signatures did not change in the switch, so ~1500 lines
of drawing code stayed as they were: `pr`, `ps`, `pdisc`, `pring`,
`ppoly`, `pline`, `pdith`, `pwash`, `pnum`.

Details that turned out to matter:

- **Color parsing is moved out of hot loops.** `col()` caches
  a string into a number, but the Map lookup itself has a cost. In `pdisc`, `pring`,
  `pline`, `ppoly`, `pnum` the color is parsed once per shape, not
  once per row or pixel.
- **Tile blitting has two paths.** A naive pass over every pixel
  turned out more expensive than the native `drawImage` we replaced
  (`drawBack` regressed from 0.10 to 0.34 ms). So: an opaque full-screen
  tile - one `set()`; a transparent one - an index of non-empty runs
  per row (`fbIndex`), computed once at creation.
  Back to 0.10 ms.
- **Text stayed on the canvas.** The buffer has no fonts, so
  `ptext()` queues strings, and `flushText()` draws them after
  `putImageData`. Only used on the start and sync screens.
- **Shake is an `OFFX/OFFY` offset in the primitives**, not `translate`.

Cached into tiles: background, foreground, the web, clouds, spider
sprites (size × leg phase), shot sprites, silk wrappings.

The fly is not cached: verified by measurement, blitting an 84×96 tile costs
the same as drawing it directly.

**Full-screen tints use `pwash` (alpha blending in the buffer),
not dithering.** Dithering with step 2 over the whole frame gives a 50/50
checkerboard that reads as a grid, not as darkening.

Frame time (cairo CPU; in the browser upscale and compositing run on the GPU):

| Scenario | Before refactor | After |
|---|---|---|
| Calm | 1.18 | **0.95** |
| 4 spiders, 10 shots | 2.08 | **1.35** |
| 12 spiders, 40 shots | 3.17 | **1.58** |
| Silk 0.9 + 12 spiders | 2.95 | **1.89** |
| Storm with rain | 3.61 | **2.18** |
| Night, downpour, lightning | 4.59 | **1.99** |

Cached into tiles: background, the web, spider sprites (size × leg phase),
shot sprites, silk wrappings (per stage).

The fly is not cached: blitting an 84×96 tile costs the same as drawing
it directly. Verified by measurement, not assumption.

**Full-screen tints use `pwash` (alpha fill), not dithering.**
Dithering with step 2 over the whole frame gives a 50/50 checkerboard that reads
as a grid, not as darkening.
