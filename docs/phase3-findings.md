# Phase 3 findings

**The measurements below were taken on a desktop, not an iPad.** They come from desktop Chrome on a Mac,
so they show whether the design works and where its costs are, not how an iPad will behave. The
[on-device checklist](phase3-ipad-checklist.md) fills that gap. The only iPad results so far are the
author's own impressions, noted where they appear.

## What was built

- **Inherited blocks:** any canvas can inherit another canvas's full visible composite as a live,
  read-only block below its own layers. The block has a placement (fit inside, or move, scale, rotate and
  flip), a crop, effects (grayscale, invert, posterize), opacity, blend mode (normal, multiply, screen,
  overlay) and visibility. All of these are applied on the GPU at render time, and no pixels are copied
  into layers.
- **Chains and the graph:** an inheritor's cached composite includes its block, so chains work. Cycles are
  refused before an arrow is made, and chains deeper than 8 get a warning.
- **Propagation:** composite changes are collected once per frame and mapped through each inheritor's
  crop and placement, sources first. Canvases are rendered in stages by depth, so a whole chain can update
  within one frame. Inheritors that are off screen during a stroke wait until it ends.
- **Interface:**
  - arrows with three opacity levels, connection handles, cycle dimming, retarget and delete, and a stub
    for relinking a deleted source;
  - a block row and properties in the layers panel;
  - block-transform mode;
  - lineage outlines and a dependents badge;
  - a background eye toggle;
  - every action is undoable.
- **Measurement:**
  - the HUD's `chain ms` line (change → end of chain) and `inheritance` line;
  - Chain and Fan-out stress runs;
  - the JSON export of propagation by depth.

## Desktop measurements

**Setup:**
- Mac, Chrome 152, viewport 1512 × 736 at devicePixelRatio 2, 120 Hz display (one frame = 8.3 ms).
- Stress runs: 1024 × 1024 canvases, all on screen, 10 scripted strokes on the root. Each stroke is 48
  samples fed 4 per frame. Each run was done in a fresh tab.
- Times run from the moment a change reaches the renderer to the GPU submit of the frame where that
  inheritor has caught up. They leave out input latency and display.

**Update time vs. chain depth** (WebGPU, times for the deepest inheritor, p50 / p95 ms):

| Chain depth | End of chain | p95 by depth | Frame p50 / p95 | Frames with stale inheritors |
| ----------- | ------------ | ------------ | --------------- | ---------------------------- |
| 1  | 8.1 / 9.1  | d1 9.1 | 8.3 / 8.8 | 0 |
| 3  | 8.2 / 8.9  | d1–3 8.9 | 8.3 / 8.9 | 0 |
| 5  | 8.2 / 15.1 | d1–4 ≈9, d5 15.1 | 8.3 / 8.4 | 7 |
| 8  | 8.3 / 34.1 | d1–4 ≈9, d5 16, d6 17, d7 25, d8 41 | 8.3 / 8.5 | 48 |
| 10 | 8.7 / 66.3 | d1–4 ≈9, d5 16, d6 17, d7 24, d8 42, d9 50, d10 217 | 8.3 / 8.5 | 97 |

**Update time vs. fan-out** (WebGPU, all inheritors at depth 1):

| Inheritors | End of fan-out p50 / p95 | Any inheritor p50 / p95 | Frame p50 / p95 | Frames with stale inheritors |
| ---------- | ------------------------ | ----------------------- | --------------- | ---------------------------- |
| 1  | 8.2 / 9.0   | 8.2 / 9.0   | 8.3 / 9.1 | 0 |
| 5  | 8.2 / 16.7  | 8.2 / 10.8  | 8.3 / 8.6 | 19 |
| 10 | 16.5 / 25.4 | 9.4 / 24.9  | 8.3 / 9.3 | 122 |
| 20 | 41.1 / 58.1 | 26.0 / 50.8 | 8.3 / 9.2 | 132 |

**WebGL2 gave the same results to within about 1 ms:**
- chain 5: 8.2 / 15.6;
- chain 10: 8.4 / 66.6, with d10 at 216 ms p95;
- fan-out 10: 16.6 / 25.1;
- fan-out 20: 41.5 / 57.9.

**Memory:** peak GPU memory (the app's estimate of its textures) was 224–225 MB in every run. Inheritance
adds no layer tiles, only composite cache tiles, a staging texture and a small lookup texture.

**What the numbers say:**
- **The limit is the planner's per-frame budget, not the GPU.** Frame times stay at 8.3 ms in every run,
  and the two backends match. Each frame recomposites at most 48 tiles (`COMPOSITES_PER_FRAME`), sources
  first. A deep chain or a wide fan-out needs more tiles per frame than that, so later inheritors wait one
  or more frames.
- **Up to depth 4 a chain updates in the same frame. Depths 5–6 take two frames, and each level after that
  adds roughly a frame.** At depth 10, a few late updates (mostly the last stroke's pen-up) reach 217 ms.
  I haven't investigated that tail further.
- **Fan-out shares the budget evenly.** Before a fairness fix, the same inheritors lost the budget every
  frame and only updated after the stroke ended (fan-out 20: worst 350 ms). Now a canvas the budget skipped
  goes first next frame (worst 58 ms). The median rose from 9 to 41 ms because all 20 now share the budget.
- **The budget is a tile count, not a time.** On this desktop there is plenty of frame time left, so a
  larger budget would shorten deep chains and wide fan-outs. On an iPad, a larger budget could instead
  lengthen frames. It should be tuned on the device (see the concerns below).

**iPad impressions (the author's own, not measured):** a 6-canvas chain (5 inheritors) on WebGPU and on
WebGL2: the stroke reached the last canvas "with no perceivable lag; it felt simultaneous."

## Known issues

1. **Arrows are straight lines.** Curved, node-editor-style arrows are planned for a later phase (agreed).
   Straight arrows can cross canvases that lie between source and inheritor.
2. **Arrows can only be tapped in the space between canvases.** A press on a canvas always draws, so an
   arrow that crosses a canvas can be selected only where it is over empty space.
3. **The arrow action bar can cover part of a canvas** while an arrow is selected.
4. **Handle positions are provisional.** The connection handle sits at the canvas's top-right corner (the
   name label is at the top left), and it will be revisited when the design is refined.
5. **The block row thumbnail is approximate.** It shows the source's layer thumbnails over its paper,
   without the source's own block, effects or placement.
6. **Transform mode:**
   - the rotate handle can end up under the toolbar when the block's top is near the top of the screen;
   - scaling is always about the block's centre.
7. **In portrait, the HUD and the floating bars compete for the bottom of the screen.**
   - On the iPad, the transform-mode Done bar was hidden behind the HUD. That is now fixed: the bar sits
     above everything, and choosing a tool also exits.
   - The HUD can now be collapsed.
   - I haven't checked whether other bars (the arrow action bar, the undo indicator) overlap the
     expanded HUD in portrait.
8. **Deep chains have a long tail** (depth 10: p95 217 ms at the end of the chain). This is beyond the
   depth-8 warning.
9. **Off-screen inheritors are stale during a stroke by design.** They catch up when the stroke ends or
   when they come into view. Until then, a canvas that scrolls into view mid-stroke may briefly show the
   older content.
10. **A small inheritor samples a coarser pyramid level of its source.** This is cheap and right on
    screen. Zooming in on it then rebuilds at a finer level, so it is briefly soft.
11. **The WebGL2 eviction stall from Phase 2 still applies.** It shows when a chain's sources must be
    reloaded from compressed memory.
12. **Interaction tests were desktop only.** Pointer capture can't be scripted, so arrow dragging was
    checked with real mouse clicks and tap-then-pick. Pencil and finger use is untested apart from the
    author's iPad tries.

## Concerns about the Phase 3 gate

- **On desktop the gate is met with little margin.** A 5-level chain catches up in one frame at the median
  and two frames at p95 (15 ms). The fifth level is exactly where the budget starts to defer work, so a
  slower GPU, larger canvases or more tiles touched per frame (a big brush, fast strokes) could push depth
  5 to three frames or more.
- **What happens on a slower GPU is open.** On desktop the budget, not the GPU, is the limit. On an iPad
  the GPU may be the limit instead: frames would lengthen (the root stroke itself gets slower) rather than
  inheritors waiting. Checklist section 1 shows which happens. Record both `frame ms` and `chain ms`.
- **The budget may need tuning per device.** If the iPad's frames stay well under 8.3 ms during the chain
  run, raising `COMPOSITES_PER_FRAME` would bring deep chains and fan-outs closer to one frame. If frames
  are already long, the budget should stay and the limit becomes the number of levels that update in the
  same frame.
- **The measurement ends at GPU submit.** It doesn't include input latency or display. What the gate calls
  "visibly within one or two frames" needs the hand test in checklist section 1b, not just the HUD number.
- **120 Hz vs. 60 Hz.** At 60 Hz a frame is 16.7 ms, so the same work fits "one or two frames" more easily.
  But Safari on iPad may run at 60 Hz in some cases (Low Power Mode, some WebGL2 paths), so note the refresh
  rate.
