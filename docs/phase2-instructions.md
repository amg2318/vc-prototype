# Task: Build Phase 2 (multi-canvas workspace)

## Context
This repo contains Phases 0–1 of my thesis project: a free, open-source, tablet-first web
drawing tool (Procreate-style painting + Figma-style multi-canvas layout, iPad + Apple Pencil
first). Phase 1 works: tiled raster layers (256 × 256, sparse), a compositor that takes generic
layer sources, command-based undo with tile diffs, brush/eraser/eyedropper, gestures, keyboard
shortcuts, a HUD and a stress-test mode.

Read the existing code and README first, and keep everything working.

Phase 2 replaces the single canvas with an infinite workspace holding many independent
canvases. The gate for this phase is: **a 20-canvas project at print size stays within iPad
memory limits, with smooth panning and no crashes.**

## Start with a plan
Before coding, propose a short plan for the coordinate systems, rendering and culling,
previews (level of detail), the tile residency/eviction system, and how undo becomes
workspace-wide. Wait for my approval.

## Architecture requirements

1. **Coordinates**
   - Three spaces: workspace → canvas → tile. Each canvas has a position in the workspace.
   - One GPU surface renders the whole workspace (no `<canvas>` element per canvas).

2. **Rendering, culling and previews**
   - Render only canvases intersecting the viewport.
   - Each canvas keeps a cached composite. When a canvas appears small on screen, draw a
     low-resolution preview (for example a mip chain or a few fixed preview sizes) instead of
     full-resolution tiles.
   - Update previews incrementally from dirty tiles, not by re-rendering the whole canvas.
   - Canvases can overlap; keep a z-order with "bring to front."

3. **Tile residency and eviction**
   - Set a configurable GPU memory budget for full-resolution tiles. When over budget, evict the
     least recently visible tiles (LRU).
   - Evicted tiles must not simply stay in JS memory as raw pixels: on iPad, GPU and JS memory
     come from the same limited pool. Compress them (for example deflate via
     `CompressionStream` on raw RGBA, or another lossless option you propose).
   - Put this behind a **tile store interface** (get/put/evict/has by tile key). In Phase 4
     I'll replace the backing with a content-hashed store in OPFS, written from a Web Worker.
     Do compression in a worker if it measurably helps frame times.
   - When a canvas scrolls back into view, show its preview immediately and swap in
     full-resolution tiles as they reload. Never show blank tiles.
   - Undo history must keep working for evicted tiles (its stored "before" tiles count against
     memory too; include them in the budget logic or compress them as well).

4. **Workspace-wide undo**
   - One undo history across the workspace. Every command records which canvas it affects.
   - Add commands: create, delete, duplicate, move, resize, rename canvas, and change z-order.
   - Undoing a change on an off-screen canvas doesn't move the camera; briefly highlight the
     affected canvas (or show a small indicator pointing toward it).

5. **Prepare for Phase 3 (inheritance)**
   In Phase 3, a canvas will display another canvas's composite as a transformed, read-only
   block, updated live through chains. Please:
   - Expose an event when a canvas's composite changes: `(canvasId, dirtyRect)`.
   - Provide a way to get a canvas's composite as a GPU texture at a requested resolution
     (full or a preview level).
   - Leave a rendering pass above canvases for overlays (Phase 3 draws arrows there).
   Don't build inheritance itself.

## Features
- **Workspace navigation:** pan and pinch-zoom anywhere (wide zoom range); "zoom to fit all";
  double-tap a canvas name to zoom to that canvas; a simple canvas list/navigator panel; a
  subtle background so empty space is recognizable.
- **Drawing:** the pen draws on whichever canvas the stroke starts on, clipped to that canvas.
  That canvas becomes active, and the layers panel shows its layers. Strokes that start outside
  every canvas do nothing.
- **Canvas management:**
  - Create a canvas from presets: A4 300 dpi (2480 × 3508), US Letter 300 dpi (2550 × 3300),
    comic page 6.625 × 10.25 in at 300 dpi (1988 × 3075), square 2048 × 2048,
    1920 × 1080, and custom. Respect the max size from config (4096 × 4096).
  - Select a canvas by tapping its name label; move it by dragging the label (the pen inside a
    canvas always draws). Optional snapping to a grid and to other canvases' edges.
  - Resize changes the canvas dimensions (extend or crop around an anchor point), not the
    pixel scale. Set from a properties panel with presets, custom width/height and an anchor.
  - Rename, duplicate, delete (with undo), bring to front.
  - Name labels above each canvas at a constant on-screen size.
- **HUD additions:** visible canvases, resident tiles and GPU MB, compressed tiles and MB,
  evictions and reloads per second, reload latency, undo memory.
- **Stress mode:** extend it to create N canvases at a chosen preset with M layers of scripted
  strokes each, then pan across them automatically, logging memory, frame times and reload
  times to the JSON export.

## Finger and mouse input (changes Phase 1 behavior)
Users must be able to draw, erase and use the eyedropper with a finger or a mouse, not only a pen.
This changes the existing touch handling, so update it carefully and keep the pen experience
unchanged.

- **Touch model:** one finger draws (or erases, or uses the eyedropper, depending on the tool);
  two or more fingers navigate (pan, pinch-zoom) or trigger tap gestures (two-finger tap undo,
  three-finger tap redo).
- **Finger drawing setting:** `Auto` / `On` / `Off`, shown in a settings panel.
  - `Auto` (default): finger drawing is on until a pen is used in the session, then off, so
    resting a palm while using a Pencil never draws. Show a small, visible toggle so the user
    can turn it back on.
  - When finger drawing is off, one finger pans instead.
  - While a pen is down, ignore all touch (existing palm rejection stays).
- **Stroke cancellation:** if a second finger lands shortly after a one-finger stroke starts
  (within a short, configurable time and movement threshold), cancel that stroke without
  adding it to the undo history, and treat the input as a two-finger gesture. This prevents
  stray marks when starting a pinch or a two-finger tap.
- **Eyedropper with finger:** touch-and-hold without moving (about 400 ms, configurable) opens
  the eyedropper and discards the tiny stroke that started. Moving before the delay keeps it a
  stroke.
- **Mouse:** left button draws with the active tool; Alt/Option + click (or hold) uses the
  eyedropper; middle-drag or space + drag pans; wheel zooms. Suppress the context menu on
  canvases.
- **No pressure input:** a mouse reports a fixed pressure (usually 0.5) and touch pressure
  varies by device. For mouse and finger, ignore reported pressure and use a constant, with an
  optional "simulate pressure from speed" setting (faster = thinner). Keep the pen pressure
  curve for pens only.
- **Workspace interactions:** a single finger or mouse drag on a canvas name label moves the
  canvas. A one-finger or mouse drag on empty workspace space pans.
- Add each input type to the `PenSample` abstraction cleanly (pointer type, whether pressure is
  real), rather than special-casing them inside the brush code.

## Out of scope
Inheritance and arrows, saving/loading and version history, selection/transform tools inside
canvases, layer groups, comic page guides. Don't build them, but don't block them.

## Testing
- Unit tests: coordinate transforms between all three spaces, viewport culling, LRU eviction
  and reload, compression round-trips, preview updates from dirty tiles, and undo/redo for every
  new canvas command (including undo involving evicted tiles).
- You can't test on my iPad, so don't claim device results. Give me an on-device checklist:
  stress mode with 20 canvases at A4 300 dpi and 5 layers each, then increasing until problems
  appear (record HUD numbers); fast panning and zooming across all canvases; drawing right
  after scrolling a canvas back into view; undo across canvases; WebGPU vs. WebGL2; Safari tab
  vs. installed home-screen app.

## Deliverables
1. The plan (before coding), then the features above.
2. Updated README: workspace navigation, canvas management, presets, memory settings, stress
   mode options.
3. The on-device checklist.
4. A short findings note: desktop measurements, the memory budget you recommend for iPad, known
   issues, and any concerns about the Phase 2 gate.

## How to work
- Commit in small, working steps with clear messages.
- Ask me before changing direction on anything in "Architecture requirements."
- Prefer simple, readable code; thesis examiners will read it.