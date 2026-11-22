# Phase 3 on-device checklist (iPad + Apple Pencil)

**Gate:** a 5-level chain updates visibly within one or two frames during a stroke on the iPad.

Fill in one copy per device. Open the app with `?stress` (add other parameters with `&`). The **Chain** and
**Fan-out** buttons reset the stats themselves; press **Export JSON** with a label after each run. Test in
a Safari tab first, then as a home-screen app (from the GitHub Pages URL). At 120 Hz one frame is 8.3 ms,
so "one or two frames" means a `chain ms` of about 17 ms or less (33 ms at 60 Hz).

## Device

| Field                                       | Value |
| ------------------------------------------- | ----- |
| iPad model and RAM                          |       |
| iPadOS / Safari version                     |       |
| Display refresh rate (60 Hz / 120 Hz)       |       |
| Pencil model                                |       |
| HUD `renderer` line                         |       |
| Low Power Mode off, charger connected       |       |

## 1. The gate: a 5-level chain

**a. Scripted.** In **Brush details & debug**, set Chain depth 5, Root strokes 10, and press **Chain**.

| Record | WebGPU | WebGL2 (`&renderer=webgl2`) |
| ------ | ------ | --------------------------- |
| Banner: chain end p50 / p95 ms | | |
| Banner: frame p50 / p95 ms | | |
| Banner: p95 for d1 … d5 | | |
| Export JSON label | | |

**b. By hand.** On the same chain, draw on the root with the Pencil, slowly and then fast, while watching
the end of the chain.

| Check | WebGPU | WebGL2 |
| ----- | ------ | ------ |
| The last canvas follows the stroke as it is drawn, not only at pen-up | | |
| It feels simultaneous / a visible delay / it trails behind | | |
| HUD `chain ms` p50 / p95 while drawing | | |
| HUD `frame ms` while drawing (does the root's own stroke stay smooth?) | | |
| Collapse the HUD (tap ▾ HUD): does it feel the same without it? | | |

## 2. Fan-out to 10–20 inheritors

Reload, set Fan-out 10 and press **Fan-out**. Repeat with 20 in a fresh tab.

| Record | Fan-out 10 | Fan-out 20 |
| ------ | ---------- | ---------- |
| Banner: chain end p50 / p95 ms | | |
| Banner: frame p50 / p95 ms | | |
| Drawing on the root by hand: do all inheritors update during the stroke? | | |
| Does any inheritor lag noticeably behind the others? | | |
| Does the root's own stroke stay smooth? | | |

## 3. Drawing with sources off screen

Build a Chain of 5. Zoom so that only the **last** canvas fills the screen.

| Check | Result |
| ----- | ------ |
| Draw on the last canvas's own layer: smooth, block still shows underneath | |
| Pan so only the **root** is on screen, draw a stroke, then pan back to the end of the chain: is the stroke there? How long until it appears (immediately / brief soft preview / blank)? | |
| With the root half on screen and the last canvas half on screen, draw on the root: does the visible inheritor update during the stroke? | |
| HUD `inheritance … stale` while drawing with inheritors off screen, and after pen-up (should return to 0) | |

## 4. Fast panning with chains

Build a Chain of 10 and a Fan-out of 20 (both in one tab). Pan quickly back and forth with two fingers and
zoom in and out.

| Check | Result |
| ----- | ------ |
| `frame ms` p50 / p95 while panning | |
| Any canvas blank, or showing wrong content (wrong effect, wrong placement)? | |
| How long do soft previews take to sharpen after you stop? | |
| `gpu memory` in the HUD | |
| Any reload or crash ("A problem repeatedly occurred")? | |

## 5. Arrows: create, retarget, delete

Use three empty canvases (`?canvases=3`). Repeat each row with **Pencil**, **finger** and **mouse /
trackpad** (if you have one), and **undo after each** action (two-finger tap), checking that undo restores
exactly the previous state; then redo.

| Action | Pencil | Finger | Mouse | Undo / redo correct? |
| ------ | ------ | ------ | ----- | -------------------- |
| Drag a canvas's handle (top-right ring) onto another canvas: arrow appears, block shows | | | | |
| Tap the handle, then tap a canvas | | | | |
| Tap an arrow to select it (grips and action bar appear) | | | | |
| Drag the selected arrow's tail onto another canvas (source changes, settings kept) | | | | |
| Drag the selected arrow's head onto another canvas (arrow moves, old canvas keeps an empty block) | | | | |
| **Change source…** then tap a canvas | | | | |
| **Delete arrow** | | | | |
| Handles and grips easy to hit (44 pt)? Any accidental strokes? | | | | |

## 6. Cycle prevention while dragging

Make a chain A → B → C. Drag C's handle towards A, and A's selected-arrow tail towards C.

| Check | Result |
| ----- | ------ |
| Canvases that would make a loop are dimmed while dragging; valid ones are outlined green | |
| Dropping on a dimmed canvas does nothing (no arrow, no undo step) | |
| The source picker in the block properties disables loop choices | |

## 7. Deleting a source, then relinking via the stub

Chain A → B → C. Delete B (Canvases panel).

| Check | Result |
| ----- | ------ |
| C shows a red dashed stub on its left; its block row says "source deleted" | |
| C keeps showing the last content? (or blank: note which) | |
| Tap the stub, then tap A: C now inherits A with its old settings | |
| Undo the relink, then undo the delete: B comes back and A → B → C is linked again | |

## 8. Block properties and transform mode

| Check | Pencil | Finger |
| ----- | ------ | ------ |
| Opacity slider and blend modes update live; one undo step per slider drag | | |
| Effects (grayscale, invert, posterize) look right | | |
| Crop fields; Reset crop | | |
| **Transform**: move, scale (corner), rotate (snaps near 15°); one undo step per drag | | |
| Leave transform mode with **Done** in portrait **and** landscape (HUD expanded and collapsed) | | |
| Rotate handle reachable when the block's top is near the top of the screen? | | |
| Hide the background (Background ●): inheritors show only the strokes; undo restores it | | |

## 9. WebGPU vs. WebGL2, Safari tab vs. installed app

Repeat section 1 (both parts) in each of the four combinations.

| | Safari tab | Home-screen app |
| -- | ---------- | --------------- |
| WebGPU: chain end p50 / p95, frame p95 | | |
| WebGPU: feels simultaneous? | | |
| WebGL2: chain end p50 / p95, frame p95 | | |
| WebGL2: feels simultaneous? | | |

## 10. Notes

Anything else: crashes, visual glitches (seams, wrong colours, flicker at block edges), gestures that
misfired, places where the HUD or a bar covered something you needed.
