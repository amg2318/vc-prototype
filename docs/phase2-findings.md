# Phase 2 findings

**None of this was measured on an iPad.** All numbers come from desktop Chrome on a Mac (headless,
driven by test scripts), so they show whether the design works and where its costs are, not how an iPad
will behave. The [on-device checklist](phase2-ipad-checklist.md) fills that gap.

## What was built

- A workspace of independent canvases with one undo history, canvas management (presets, move with
  snapping, resize around an anchor, rename, duplicate, delete, z-order) and an off-screen undo indicator.
- A **composite pyramid** per canvas (256² tiles at five levels). The display uses the level that matches
  the zoom, so the screen needs about the same number of tiles at any zoom. Levels 3–4 are always cached,
  so every canvas can always be drawn.
- **Tile residency:** layer tiles stay on the GPU within a budget; the least recently used are read back,
  deflate-compressed and kept in JS memory, and reloaded when needed. Tile ids are separate from GPU slots.
- Finger and mouse drawing, Figma-style laptop navigation, HUD additions, stress mode, Phase 3 hooks.

## Desktop measurements

Mac, Chrome 156, WebGPU unless noted, viewport 1180 × 820 at devicePixelRatio 2.

**Panning (plugged in).** 20 empty A4 canvases panned at 60 fps with about 0.3 ms of render CPU per
frame. Nine A4 canvases × 3 layers × 4 strokes with a 32 MB layer budget: auto-pan at 16.7 ms p50 and p95.

**Eviction correctness.** Six canvases with a deliberately tiny 16 MB budget (64 tiles), on both backends:
about 600 evictions and 300 reloads, then zooming back in showed sharp, correct strokes, and the eyedropper
read the exact stroke colour. Undo of a stroke whose "before" tiles were evicted brings them back (unit
test, end to end through the editor and RenderCore).

**The gate scenario: 20 A4 canvases × 5 layers × 6 strokes** (6,401 layer tiles in use):

| Layer budget | Peak GPU (estimate) | Compressed in JS | JS heap | Evictions / reloads during one auto-pan |
| ------------ | ------------------- | ---------------- | ------- | --------------------------------------- |
| 256 MB (default) | 481 MB | 5,377 tiles, 18 MB | 38 MB | 7,578 / 7,578 |
| 128 MB | 353 MB | 5,889 tiles, 20 MB | 40 MB | 7,672 / 7,672 |
| 64 MB | 289 MB | 6,145 tiles, 21 MB | 39 MB | 7,728 / 7,728 |

- Compression works well for sketch content: about 3.5 KB per tile against 256 KB raw.
- Peak GPU is the app's own estimate of its textures (layer pages, three 64 MB composite pages, masks); the
  browser adds its own overhead on top.
- Undo memory reached its 256 MB cap (counted at raw tile size), so the oldest steps were being dropped.
- **Frame times for these runs are not usable.** The Mac was on battery in Low Power Mode, which held
  headless Chrome at 30 fps: a run that gave 60 fps earlier gave 30 fps on rerun, and render CPU stayed at
  0.3 ms per frame. Reload latency (p50 33 ms, p95 34 ms) is just as affected.

**WebGL2 during heavy eviction.** WebGL2 has no asynchronous readback, so an eviction stalls the frame. In
the 16 MB test, composite CPU time was 16.9 ms p50 and 85.5 ms p95 during a reload storm; WebGPU stayed
under about 1 ms.

## Recommended iPad memory budget

**Start with a 128 MB layer budget (`?layerBudgetMB=128`), about 350 MB of GPU textures in total.**

- Safari doesn't document how much memory a tab may use on iPad, and it depends on the device's RAM.
  The 256 MB default (about 480 MB in total) is likely to be close to the limit on 4–6 GB iPads.
- In the gate scenario, 64, 128 and 256 MB behaved the same way (see the next section), so a smaller
  budget doesn't cost much while panning. It costs more when drawing on many different canvases in turn,
  because their layer tiles must reload first.
- Checklist section 2 (runs a–c) decides it. If 128 MB pans smoothly on the iPad, make it the default in
  `src/config.ts`; if 64 MB does too, consider going lower on low-RAM devices.

## Known issues

1. **The preview cache is too small for 20 busy canvases at medium zoom.** At a zoom where one A4 canvas
   fills the screen, the display uses level-1 tiles: 35 per canvas, 700 for 20 canvases. The two preview
   pages hold 512 tiles, shared with the always-kept levels. So when the pan comes back to a canvas, its
   level-1 tiles have been evicted and are rebuilt from level 0, which needs all its layer tiles. That
   is why about 7,600 tiles were reloaded per pan **whatever the layer budget**. While this happens the
   canvas shows its coarser level-3 preview, so it is never blank, only briefly soft. Options to try on
   the device: a third preview page (+64 MB), or keeping level 2 for every canvas as well.
2. **WebGL2 stalls while evicting** (synchronous `readPixels`, see above). WebGPU is unaffected.
3. **Undo memory counts tiles at raw size** (256 KB each), even though most of them are compressed or
   shared, so history drops old steps sooner than real memory use requires.
4. **Layer thumbnails** leave out tiles that are still reloading, until the next refresh.
5. **Tile id reuse:** if a freed tile id is reused while a readback of its old pixels is still in
   flight, the old pixels could be stored under the new id. It needs very specific timing and hasn't been
   seen; it was accepted to keep the code simple.
6. **Compression runs through `CompressionStream` on the main thread's event loop.** It is asynchronous, but
   I haven't measured whether a worker would help, which the spec asked for. The JSON export's reload
   times are the data for that decision.
7. **Canvas labels are 34 px tall**, below the usual 44 pt touch target. A taller hit area would overlap
   the canvas below it.
8. **`onCompositeChanged` fires many times per frame while drawing.** Phase 3 should coalesce.

## Concerns about the Phase 2 gate

- **Memory limits are the open question.** The design keeps GPU use bounded (layer budget + fixed
  composite cache) and JS use small (compressed tiles: about 20 MB for 6,000 tiles of sketch content), but
  only the iPad can say where Safari's limit is. Dense, noisy content compresses less well than test
  strokes, so JS memory could be several times higher with real drawings.
- **Smooth panning depends on known issue 1.** On desktop the coarser preview hides the rebuilds, but an
  iPad may rebuild more slowly. If panning across busy canvases looks soft for too long, the preview cache
  needs to grow, or level 2 needs to be kept for every canvas.
- **WebGL2 may not meet the gate with a small budget**, because of the synchronous readback. WebGPU is on by
  default in Safari 26, so this matters only for older iPadOS.
- **Desktop frame times need a rerun on mains power**; this session's gate-scenario frame times were
  capped by Low Power Mode.
