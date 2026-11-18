# Phase 1 findings (desktop only)

**No iPad results are in this note.** Everything below was measured with headless Google Chrome 157 on an
Apple M5 Mac (32 GB), driven by scripted pen, touch and mouse input over the Chrome DevTools Protocol. The
on-device answers come from [the Phase 1 checklist](phase1-ipad-checklist.md).

## What was built

| Requirement                         | Status | Where                                              |
| ----------------------------------- | ------ | -------------------------------------------------- |
| 256² sparse tiles, freed when empty | Done   | `document/tiles.ts`, `tileStore.ts`; empty check in both renderers |
| Premultiplied alpha throughout      | Done   | 8-bit premultiplied atlas pages; `document/blend.ts` is the CPU reference |
| Compositor with generic sources     | Done   | `render/*/shaders.ts` (composite), `app/compositeState.ts` |
| Opacity, visibility, normal/multiply | Done  | Blend modes are evaluated in the shader; screen/overlay fit the same switch |
| Cached composite, dirty tiles only  | Done   | `FrameQueue` dirty set → composite cache texture   |
| Command undo with `canvasId`        | Done   | `history/`; strokes keep only the "before" tiles   |
| 256 MB history budget               | Done   | Oldest steps dropped; also dropped to make room when the pool is full |
| Layers panel, colour picker, eyedropper, eraser | Done | `ui/`, `tools/`                  |
| 2/3-finger tap, touch-and-hold      | Done   | `input/touchGestures.ts` (thresholds in `config.ts`) |
| Keyboard shortcuts                  | Done   | `ui/shortcuts.ts`                                  |
| HUD/export additions, `?stress`     | Done   | `debug/`                                           |
| WebGL2 fallback                     | Done   | Same feature set; no GPU timings                   |

Tests: 136 unit tests (`npm test`) cover:
- tile maths and the tile store;
- the blend reference;
- every command's undo/redo, checked by snapshot;
- reference-count leak checks after each sequence;
- history budget trimming and pool exhaustion;
- frame queue and GPU data packing;
- the gesture recogniser and colour conversions.

## Design decisions worth knowing

- **Copy-on-write tiles.** A stroke never edits a tile in place. Undo is a reference swap, with no pixel
  copies and no GPU readback, so undo cost doesn't depend on stroke size. The trade-off is that history
  memory counts in whole tiles (256 KB each): a one-pixel dot keeps a whole old tile alive.
- **The live stroke is composited in the shader** on its own layer, so the preview matches the committed
  result exactly. This holds below other layers, at reduced layer opacity, and under multiply.
- **Freeing empty tiles needs a GPU readback.** It is asynchronous on WebGPU and synchronous
  (`readPixels`) on WebGL2. The check runs only after eraser strokes. A generation number per slot stops
  a stale result from freeing a tile that was reused in the meantime.
- **The atlas grows in pages.** Pages are created when first needed, so a small drawing doesn't reserve
  512 MB. A page is never freed while the app runs; see the risks below.

## Desktop measurements (headless Chrome, not representative of an iPad)

| Scenario (`?stress`)       | WebGPU                                   | WebGL2                    |
| -------------------------- | ---------------------------------------- | ------------------------- |
| 200 strokes                | 3.6 s; history capped at 256 MB (68 steps kept) | 3.3 s; same        |
| Fill 32 layers             | pool full at 2045/2048 slots; history trimmed to 34 MB to make room | same |
| Undo + redo 101 steps      | 3.4 s (one step per frame)               | 3.4 s                     |
| Composite, 32 layers, ~40 dirty tiles | GPU p50 5.4 ms / p95 9.9 ms   | not measurable            |
| Composite, 1–2 layers, ~16 dirty tiles | GPU p50 1.0 ms / p95 1.3 ms  | not measurable            |
| Composite CPU encode       | ≤ 0.3 ms                                 | ≤ 0.3 ms                  |
| Frame interval p95 while filling layers | 66.6 ms                     | 66.6 ms                   |
| GPU memory at full pool    | ≈ 608 MB (8 pages + masks + composite cache) | ≈ 608 MB              |

Scripted input can't say anything about how drawing feels; compare the HUD latency lines against Phase 0
on the iPad.

## Risks to check on the iPad

1. **Memory ceiling.** A full pool is ≈ 608 MB of textures. Safari on iPad may kill the tab well before
   that, especially on 4 GB / 6 GB models. The stress tests are designed to find where. If it crashes,
   the fix is to lower `MAX_ATLAS_PAGES` (and with it the history budget) in `config.ts`, or to pick the
   value at startup from the device. That would change the approved 512 MB cap, so it needs your decision.
2. **Frame spikes when a new atlas page is created** (the 66 ms p95 above). Creating a 64 MB texture
   mid-stroke may cause a visible hitch on the iPad. If it does, pages could be created ahead of need.
3. **Composite cost with many layers.** At 32 layers, desktop GPU time was about 5–10 ms for a
   stroke-sized dirty area. An iPad GPU at 120 Hz has an 8.3 ms budget per frame, so heavy multi-layer
   documents might drop frames while drawing. The composite GPU timing in the HUD (WebGPU only) will show
   this.
4. **Palm detection by contact size** relies on Safari reporting `PointerEvent.width/height` for touches.
   If it reports a constant, size-based palm rejection does nothing. Taps still require the pen to be up
   and the fingers to stay still, so the main protection remains.
5. **WebGL2 readbacks are synchronous.** Eyedropper, thumbnails and the empty-tile check can briefly stall
   the WebGL2 path. This only matters on the fallback.
6. **Atlas pages are never released** during a session, even after deleting layers. Memory stays at its
   high-water mark until reload. That's acceptable for Phase 1, and worth revisiting with saving and
   loading.
