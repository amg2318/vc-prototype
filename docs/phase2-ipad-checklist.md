# Phase 2 on-device checklist (iPad + Apple Pencil)

**Gate:** a 20-canvas project at print size stays within iPad memory limits, with smooth panning and no
crashes.

Fill in one copy per device. Open the app with `?stress` (add other parameters with `&`). Press
**Reset stats** before each measured run and **Export JSON** with a label afterwards; **Auto-pan** resets
the stats itself. Test in a Safari tab first, then as a home-screen app (from the GitHub Pages URL).

## Device

| Field                                       | Value |
| ------------------------------------------- | ----- |
| iPad model and RAM                          |       |
| iPadOS / Safari version                     |       |
| Display refresh rate (60 Hz / 120 Hz)       |       |
| Pencil model                                |       |
| HUD `renderer` line                         |       |
| Low Power Mode off, charger connected       |       |

## 1. The gate: 20 A4 canvases × 5 layers

Open `?stress`. In **Brush details & debug**: Canvases 20, Preset A4, Layers each 5, Strokes per layer 6.
Press **Build workspace**, wait for the result banner, then press **Auto-pan**.

| Step | Record |
| ---- | ------ |
| Build finished without a reload or crash ("A problem repeatedly occurred" = crash) | |
| Build banner: tiles, undo MB | |
| HUD after build: `tiles … on gpu … compressed …` | |
| HUD after build: `gpu memory` | |
| Auto-pan banner: frame ms p50 / p95 | |
| Auto-pan banner: evictions, reloads, reload p95, peak GPU | |
| Did any canvas look blank, or show wrong content, during the pan? | |
| Export JSON label (e.g. `gate webgpu tab`) | |

## 2. Push until it breaks

Repeat section 1 in a fresh tab, raising one thing at a time. Note the last setting that worked and what
happened at the next one (slowdown, blank tiles, banner, tab reload, crash).

| Run | Canvases × layers × strokes | `?layerBudgetMB=` | Result (HUD `gpu memory`, frame p95, crash?) |
| --- | --------------------------- | ----------------- | -------------------------------------------- |
| a   | 20 × 5 × 6                  | 256 (default)     |                                              |
| b   | 20 × 5 × 6                  | 128               |                                              |
| c   | 20 × 5 × 6                  | 64                |                                              |
| d   | 30 × 5 × 6                  | best of a–c       |                                              |
| e   | 40 × 5 × 6                  | best of a–c       |                                              |
| f   | 20 × 10 × 10                | best of a–c       |                                              |

The run with the lowest budget that still pans smoothly decides the iPad default (see the findings note).

## 3. Navigation (with the 20-canvas workspace)

| Test | OK? | Notes |
| ---- | --- | ----- |
| Fast two-finger pans across all canvases: smooth? `fps` in the HUD | | |
| Pinch from all 20 canvases down to one canvas at 400%+ and back | | |
| Zoomed out, every canvas shows its content (never blank or paper-only for long) | | |
| **Fit all** in the Canvases panel; double-tap a label zooms to its canvas | | |
| One finger on empty space pans | | |

## 4. Drawing after scrolling back

| Test | OK? | Notes |
| ---- | --- | ----- |
| Zoom into a canvas you haven't looked at for a while and draw straight away: does the stroke appear immediately? Does the canvas sharpen within a second? | | |
| Same with `?layerBudgetMB=64` (more tiles evicted) | | |
| HUD `reload ms` p50 / p95 after doing this a few times | | |
| Strokes stop at the canvas edge; a stroke starting between canvases pans | | |

## 5. Undo across canvases

| Test | OK? | Notes |
| ---- | --- | ----- |
| Draw on canvas A, pan to canvas B, two-finger tap: the amber chip appears at the edge pointing to A, and the camera doesn't move | | |
| Tapping the chip goes to A; the stroke is gone | | |
| Three-finger tap (redo) brings it back | | |
| Undo/redo of create, delete, duplicate, move, resize, rename and bring to front | | |
| **Undo / redo all** in stress mode completes without errors | | |

## 6. Canvas management

| Test | OK? | Notes |
| ---- | --- | ----- |
| Create each preset; a custom size above 4096 is clamped to 4096 | | |
| Drag a label with a finger and with the Pencil: the canvas moves, snapping to other canvases' edges | | |
| Resize with different anchors: content stays put, the canvas extends or crops | | |
| Rename, duplicate (shares content), delete, bring to front | | |
| Labels are easy enough to hit with a finger (they are 34 px tall, below the usual 44 pt) | | |

## 7. Finger and Pencil input

| Test | OK? | Notes |
| ---- | --- | ----- |
| Before using the Pencil: one finger draws; the **Finger** button is lit | | |
| After the first Pencil stroke: one finger pans; the button is dim; tapping it turns finger drawing back on | | |
| Start a one-finger stroke, then quickly put down a second finger: no mark is left and you pinch instead | | |
| Two-finger tap right after a one-finger touch undoes the previous stroke (not a stray dot) | | |
| Touch and hold (0.4 s) opens the eyedropper and leaves no dot | | |
| Resting your palm while drawing with the Pencil never draws or moves the view | | |
| Pencil drawing feels the same as in Phase 1 (latency, pressure) | | |
| "Pressure from speed" (brush details): finger strokes get thinner when fast | | |

## 8. WebGPU vs. WebGL2, tab vs. home-screen app

Run section 1 (and 4) in each combination. `?renderer=webgl2` forces WebGL2. WebGL2 reads evicted tiles
back synchronously, so watch frame p95 while tiles are being evicted.

| Combination | Gate result (frame p50 / p95, peak GPU, crash?) | Notes |
| ----------- | ----------------------------------------------- | ----- |
| WebGPU, Safari tab | | |
| WebGL2, Safari tab | | |
| WebGPU, home-screen app | | |
| WebGL2, home-screen app | | |

## 9. Anything else

Crashes, tab reloads, banners, visual glitches, places where the UI was hard to use:
