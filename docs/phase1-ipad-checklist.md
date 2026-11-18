# Phase 1 on-device checklist (iPad + Apple Pencil)

**Gate:** I can draw a finished sketch on one canvas on my iPad with no crashes.

Fill in one copy per device. Press **Reset stats** before each measured run, then **Export JSON** with a
label afterwards. Test in a Safari tab first, then as a home-screen app (from the GitHub Pages URL).

## Device

| Field                                            | Value |
| ------------------------------------------------ | ----- |
| iPad model and RAM                               |       |
| iPadOS / Safari version                          |       |
| Display refresh rate (60 Hz / 120 Hz)            |       |
| Pencil model                                     |       |
| Tab or home-screen app                           |       |
| HUD `renderer` line                              |       |

## 1. Startup

- [ ] The app opens without an error. The HUD reads `WebGPU`; if not, note the fallback reason: ______
- [ ] The canvas fits the screen. The toolbar, brush panel and layers panel don't overlap in portrait or in
      landscape.
- [ ] Every button can be hit comfortably with a finger (44 pt targets).

## 2. Drawing and erasing

| Test                                                                 | OK? | Notes |
| -------------------------------------------------------------------- | --- | ----- |
| Drawing feels the same as in Phase 0 (latency, smoothness, pressure) |     |       |
| HUD `in→submit` / `in→gpu done` p95 compared with Phase 0            |     |       |
| Eraser (toolbar) erases to transparent: background shows through      |     |       |
| Erasing a whole area lowers the `tiles` count in the HUD a moment later |   |       |
| Large brush (300–400 px) strokes stay smooth                          |     |       |
| Drawing while zoomed in to 400%+ and zoomed out to the whole canvas   |     |       |
| Edges of a stroke look the same before and after lifting the pen      |     |       |

## 3. Layers

- [ ] Add layers (+). The new layer appears above the selected one and becomes selected.
- [ ] Thumbnails update about ⅓ s after a stroke.
- [ ] Drag ≡ to reorder. The picture changes accordingly.
- [ ] Hide/show (●/○), opacity slider (smooth while dragging), blend mode multiply.
- [ ] Rename (tap the name twice, or the Rename button), duplicate, clear, delete.
- [ ] Background colour change. The eraser never removes the background.

## 4. Undo / redo

- [ ] Two-finger tap = undo; three-finger tap = redo. Note how reliably they're recognised: __ / 10 attempts.
- [ ] A pinch-zoom is never mistaken for an undo.
- [ ] Resting the palm while drawing never triggers undo.
- [ ] Undo/redo every kind of step: stroke, erase, add/delete/duplicate/move/rename layer, opacity drag
      (should be **one** step per drag), visibility, blend mode, clear, background.
- [ ] Toolbar ↶ ↷ buttons are disabled when there's nothing to undo or redo.

If the tap thresholds feel wrong, adjust `GESTURES` in `src/config.ts` and note the values that worked:
______

## 5. Colour and eyedropper

- [ ] HSV picker: square and hue strip respond to Pencil and to a finger. Recent colours fill in after
      strokes.
- [ ] Eyedropper tool: the loupe shows the colour under the Pencil. Lifting returns to the
      previous tool, and selecting the eyedropper never changes the brush panel.
- [ ] Adding a second finger during a touch-and-hold cancels the pick (colour restored) and pinches.
- [ ] Touch-and-hold with one finger (about ½ s) starts the eyedropper. A resting palm does **not**.
- [ ] Picked colours match what is on screen, including over multiply layers and reduced opacity.

## 6. Memory and stability (the gate)

Open `?stress` (debug section → Stress tests) **after** completing the manual sketch below.

| Test                                                                  | Result |
| --------------------------------------------------------------------- | ------ |
| Draw a real sketch: 20+ minutes, 5+ layers, lots of undo              |        |
| Any crash, reload or "A problem repeatedly occurred" page?            |        |
| HUD `gpu memory` and `slots` at the end of the sketch                 |        |
| `?stress` → 200 strokes: time, and frame ms p95                       |        |
| `?stress` → Fill 32 layers: survives? (watch for the tab reloading)   |        |
| `?stress` → Undo / redo all: time                                     |        |
| `?stress` → Fill pool: the "memory is full" banner appears, no crash  |        |
| Background the app for 1 minute, come back: drawing still there?      |        |

If Safari kills the tab during stress tests, record which test and the `pages` / `gpu memory` values
just before. That tells us whether the 512 MB pool cap must come down on this device.

## 7. Exported files

Attach the JSON exports (they include document and memory stats) and any screenshots.
