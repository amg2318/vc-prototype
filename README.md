# VC Prototype: Phase 4 (persistence and version history)

A tablet-first web drawing tool, combining Procreate-style raster painting with Figma-style multi-canvas
layout. **Phase 4 gate:** force-closing Safari mid-session on the iPad loses at most the last stroke.

Phase 4 makes work survive: **projects are saved on the device as you draw, with a version history.**
- Each project is saved in the browser's private file system (OPFS) by a storage worker. Tiles are stored
  once by their content hash (SHA-256, compressed), so layers, canvases and versions share them.
- Autosave: a short pause after a change, at once when a second stroke ends unsaved, and at once when the
  page is hidden or closed. A save never leaves a half-written project: the head only moves once every
  file it needs is on disk.
- Versions: **Save version** (⌘S), plus automatic ones when a session ended with changes no version
  holds, and after 30 minutes of active editing. Restore keeps the current state as a "Before restore"
  version. Retention keeps manual and pinned versions and thins out automatic ones.
- Projects: create, open, rename, duplicate, delete; sizes and the storage quota; the last project opens on
  launch; a second tab opens a project read-only.
- Export and import of a project file (with or without history), and PNG export of a canvas at full
  resolution, inherited content included.
- Opening a project shows every canvas at once from saved previews, before any layer tile is loaded.

Phase 3 (below) carries over unchanged: **any canvas can inherit another canvas's content as a live,
read-only block, connected by arrows, with chains allowed.**
- The block shows the source's full visible composite (its layers and its own inherited block), so
  chains work. It sits below the canvas's own layers, and the canvas draws on its own layers only.
- Placement (fit inside, or moved, scaled, rotated and flipped), crop, effects (grayscale, invert,
  posterize), opacity, blend mode and visibility are applied on the GPU at render time. Inheritors share
  the source's cached composite: no pixels are copied.
- Arrows are created, retargeted and deleted with pen, finger or mouse. Cycles are refused, and chains
  deeper than 8 get a warning.
- A stroke reaches every inheritor down the chain within the same frame when the budget allows. Off-screen
  inheritors wait until the stroke ends.
- The HUD and stress mode measure the time from a change to the end of the chain.

Phase 2 (below) carries over unchanged: an infinite workspace of independent canvases (each up to
4096 × 4096, with its own layers):
- pan and zoom anywhere; canvases are created from print presets, moved, resized, renamed, duplicated,
  deleted and reordered, all undoable in one workspace-wide history;
- each canvas's composite is a cached tile pyramid, so a zoomed-out view of many canvases stays cheap;
- layer tiles stay on the GPU within a budget; the rest are reloaded on demand (since Phase 4 from the
  project store on disk, before that compressed in memory);
- a finger or a mouse can draw, erase and pick colours, not only a pen;
- the HUD and stress mode measure memory, evictions and reload times.

Phase 1 (layers, eraser, undo, layers panel, colour picker) carries over unchanged inside each canvas.

- [Phase 4 on-device checklist](docs/phase4-ipad-checklist.md): what to try on the iPad, starting with the gate
- [Phase 4 findings](docs/phase4-findings.md): desktop measurements, known issues, risks for the gate
- [Phase 3 on-device checklist](docs/phase3-ipad-checklist.md): what to try on the iPad
- [Phase 3 findings](docs/phase3-findings.md): desktop measurements, known issues, concerns about the gate
- [Phase 2 on-device checklist](docs/phase2-ipad-checklist.md): what to try on the iPad
- [Phase 2 findings](docs/phase2-findings.md): desktop measurements, recommended iPad memory budget, known issues
- [Phase 1 on-device checklist](docs/phase1-ipad-checklist.md)
- [Phase 1 findings](docs/phase1-findings.md): design decisions, desktop measurements, risks to check on device
- [Phase 0 checklist](docs/ipad-checklist.md) and [Phase 0 findings](docs/phase0-findings.md)

## Quick start

Requires Node 22+ (developed on Node 24).

```sh
npm install
npm run dev          # HTTPS dev server, reachable from other devices on your network
```

Open the `Local:` URL on this computer. Your browser will warn about the self-signed certificate the first
time; accept it.

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `npm run dev`       | HTTPS dev server on all network interfaces (`--host`)                 |
| `npm test`          | Unit tests (Vitest)                                                   |
| `npm run typecheck` | Strict TypeScript check                                               |
| `npm run build`     | Type-check and build to `dist/`                                       |
| `npm run preview`   | Serve the production build (HTTPS, with the offline service worker)  |

`NO_HTTPS=1 npm run dev` serves plain HTTP. That's fine on `localhost`, which browsers already treat as secure.

## Testing on an iPad

WebGPU and service workers need a **secure context**. `localhost` counts as one, but
`http://192.168.x.x` on the iPad does not, so the dev server uses HTTPS.

**Requirements:** WebGPU is on by default in Safari 26 (iPadOS 26). On older iPadOS versions the app
falls back to WebGL2 automatically, and the HUD shows why.

### Option A: self-signed certificate (no setup)

1. Put the Mac and the iPad on the same Wi-Fi network.
2. Run `npm run dev`. Note the `Network:` URL, e.g. `https://192.168.0.107:5173/`.
   If macOS asks whether Node may accept incoming connections, choose **Allow**.
3. On the iPad, open that URL in Safari. At the "This Connection Is Not Private" page, tap
   **Show Details** and then **visit this website**, and confirm.
4. Check the HUD's first line: it should read `WebGPU`.

On this path the service worker does not register, because the certificate isn't trusted. That's expected:
offline mode and the installed app are tested through Option C. If the HUD shows a WebGL2 fallback that
mentions the secure context, use Option B instead.

### Option B: trusted local certificate with mkcert (no warnings)

```sh
brew install mkcert
mkcert -install
mkdir -p .certs
mkcert -cert-file .certs/cert.pem -key-file .certs/key.pem \
  localhost 127.0.0.1 "$(ipconfig getifaddr en0)" "$(scutil --get LocalHostName).local"
open "$(mkcert -CAROOT)"      # AirDrop rootCA.pem from this folder to the iPad
```

On the iPad:

1. Open the AirDropped `rootCA.pem`, then go to **Settings → General → VPN & Device Management** and
   install the profile.
2. Go to **Settings → General → About → Certificate Trust Settings** and turn on full trust for the
   mkcert root.

`npm run dev` picks up `.certs/` automatically. The folder is git-ignored. If your Mac's IP address changes,
regenerate the certificate, or use the `.local` hostname instead.

### Option C: GitHub Pages (test the installed home-screen app)

The workflow in `.github/workflows/deploy-pages.yml` runs the tests, builds, and publishes `dist/` on every
push to `main`.

1. One-time setup: on GitHub, open **Settings → Pages → Build and deployment** and set
   **Source: GitHub Actions**.
2. Merge to `main`, or run the workflow by hand from the Actions tab.
3. On the iPad, open `https://<user>.github.io/vc-prototype/` in Safari, tap **Share → Add to Home Screen**,
   and launch it from the home screen. It opens full-screen, and it works offline after the first load.

## Using the app

| Input                              | Action                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| Apple Pencil / pen                 | Use the current tool (brush, eraser or eyedropper)                |
| Pen eraser end (Wacom etc.)        | Erase to transparent, whatever tool is selected                   |
| Mouse, left button                 | Use the current tool (full pressure, or "pressure from speed")    |
| Alt/Option + click or drag         | Eyedropper                                                        |
| One finger                         | Use the current tool when finger drawing is on; pan when it's off |
| Second finger right after a one-finger stroke starts | Cancels that stroke (no undo step); then pinch or tap as usual |
| Two fingers                        | Pan and pinch-zoom (rotation: tick "Two-finger rotate")           |
| Two-finger tap / three-finger tap  | Undo / redo                                                       |
| One finger, touch and hold (0.4 s) | Eyedropper (samples what you see: all visible layers + background); discards the tiny stroke it started; a second finger cancels it |
| Drag a canvas's name label         | Move the canvas (tap: select, double tap: zoom to it)             |
| Trackpad two-finger scroll / wheel | Pan (Shift + wheel pans sideways)                                 |
| Trackpad pinch, or ⌘/Ctrl + wheel  | Zoom at the cursor                                                |
| Drag on empty space (pen, mouse or finger), middle-drag, or Space + drag | Pan                         |
| ⌘/Ctrl + = / − / 0                 | Zoom in / out / 100%                                              |
| ⇧1 / ⇧2                            | Fit all canvases / fit the selected canvas                        |

| Key                       | Action                       |
| ------------------------- | ---------------------------- |
| ⌘Z / Ctrl+Z               | Undo                         |
| ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y | Redo                       |
| B / E / I                 | Brush / eraser / eyedropper  |
| [ / ]                     | Smaller / larger tool size   |
| ⇧N                        | New layer                    |
| H                         | Toggle HUD (Dev mode)        |
| ⌘S / Ctrl+S               | Save a version               |
| Delete / Backspace        | Delete the selected arrow    |
| Escape                    | Deselect the arrow; cancel choosing a canvas; leave block-transform mode |
| Enter                     | Leave block-transform mode   |

**Finger drawing** (brush panel, "Finger draws"): *Auto* (default) lets one finger draw until a pen is
used, then one finger pans, so a resting palm never draws. *On* / *Off* fix it either way. The
**Finger** button in the toolbar switches it on or off at any time.

**Toolbar:** brush, eraser, eyedropper, colour (opens the HSV picker with recent colours), undo, redo,
Finger (finger drawing on/off), Arrows (show or hide arrows), Canvases, Layers, History, Projects (back to
the Projects page), and the
save status (Saved / Saving… / Unsaved / Not saved / Read-only; tap it for details).

### Saving, versions and projects (Phase 4)

- **Saving is automatic.** The save status in the toolbar shows where things are. There is no "save"
  command for the working copy; ⌘S and **Save version** make a *version*.
- **History** panel: the open project's versions, newest first, with a thumbnail of the workspace, a name
  and whether it was saved by hand or automatically. Select one to **Restore** it, rename it, **Pin** it
  (pinned versions are never removed by retention) or delete it (asks again). Restoring first keeps the
  current state as a "Before restore" version (unless a version already holds it) and clears undo history.
- **Automatic versions:** "Session ended …" when a project opens whose last session left changes no
  version holds, and "Autosave …" after 30 minutes of active editing. **Retention** keeps every manual and
  pinned version; of the automatic ones, the newest 10, then the newest of each day for 30 days, then the
  newest of each week. Both numbers can be changed in **Projects page → Settings (gear)**.
- **Projects page** (design from Figma: "projects page" vertical / horizontal / empty state): the app
  opens on it. Every project on this device is a card (newest first) with a snapshot of its workspace as
  last saved and the day it was last opened ("Today", "Thursday", or a date after a week); tap a card to
  open it. Going to the page saves the open project first, so its card is up to date. **New project** creates one and opens it. Each card's **⋮** menu has
  **Rename**, **Duplicate**, **Export…** (with or without version history) and **Delete…** (asks again).
  With no projects it says "No projects yet". The last opened project is loaded behind the page, so
  tapping its card shows it at once; deleting the open project closes it. The snapshot is drawn on the
  CPU from each canvas's saved 1/16-scale preview (as version thumbnails are), read by the storage worker
  without opening the project; saves write nothing extra for it. Project sizes are in Settings.
- **Settings** (the gear on the Projects page): storage use (all projects, against the browser's
  estimate); whether the browser may clear stored projects, with a button to ask it not to; the
  retention settings; **Delete automatic versions…** and **Clean up** (removes data nothing uses; this
  also happens on its own); **Import project…**. **Dev mode** shows the HUD (same as H) and is
  remembered on this device. With Dev mode on, **Delete all data…** (asks again) deletes every project, version and setting of this app on this device (nothing of other apps
  served from the same address, such as other GitHub Pages sites); the app reloads and starts fresh.
  Close the app's other tabs first, or nothing is deleted.
- **PNG export:** Canvases panel → select a canvas → **Export PNG**: the canvas at full resolution as it
  looks (inherited content and paper included), with straight alpha.
- **Getting files out:** on the iPad the share sheet opens (choose "Save to Files", AirDrop…); on Chromium
  desktop a save dialog; elsewhere a download. If a long export outlasts the tap that started it, a
  **Save…** button appears; tap it.
- **Two tabs:** only one tab can change a project. A second tab opens it read-only and says so; nothing is
  saved there. Delete, duplicate and export are refused while another tab has the project open.
- **Storage full:** the save status turns red and a message offers to delete automatic versions or to open
  Projects (export and delete). Nothing already saved is lost; the unsaved changes stay on screen.
- **On iPad, use the home-screen app.** In a Safari tab, Safari may clear a site's data after some days
  without a visit; the app says so once per visit. A home-screen app's storage is not cleared that way.

### The workspace

- **Drawing** happens on whichever canvas the stroke starts on, clipped to that canvas, and selects it
  (the layers panel then shows its layers). A stroke that starts outside every canvas pans instead.
- **Name labels** sit above each canvas at a constant size. Tap one to select its canvas, double-tap to
  zoom to it, and drag it to move the canvas (one undo step per drag). Moves snap to other canvases' edges
  and, if enabled, to a 256 px grid.
- **Canvases panel** (toolbar → Canvases):
  - a list of every canvas (tap one to select it and zoom to it) and **Fit all**;
  - **New canvas** from a preset or a custom size up to 4096 × 4096: A4 300 dpi (2480 × 3508),
    US Letter 300 dpi (2550 × 3300), comic page 6.625 × 10.25 in at 300 dpi (1988 × 3075),
    square 2048 × 2048, and 1920 × 1080. New canvases go to the right of the others;
  - for the selected canvas: rename, **resize** (presets or width × height, around one of nine anchor
    points; this extends or crops the canvas, it never rescales pixels), duplicate, bring to front, delete;
  - snapping options for moving canvases.
- **Undo** is workspace-wide. Undoing a change to a canvas that is off screen doesn't move the camera: an
  amber chip at the screen edge points to it (tap it to go there). A change to another canvas that is on
  screen gets a brief amber outline.
- The selected canvas has a blue outline; a faint grid marks empty space.

**Layers panel:** the top layer is listed first. Tap a row to select it. Use ● to show or hide a layer, and
drag ≡ to reorder. The selected layer shows its opacity (one undo step per slider drag), blend mode, rename,
duplicate, clear and delete. **Background** sets the paper colour, which the eraser never removes; its ●
hides the paper, making the canvas transparent (shown over a checkerboard), so canvases inheriting it see
only its strokes. The inherited block has its own row at the bottom (see below).

**Palm rejection:** while the pen is down, all touch input is ignored. If a palm had already started a
pinch when the pen lands, the view snaps back. Touches with a large contact area
(`GESTURES.palmContactPx` in `src/config.ts`) never count as taps or holds. All gesture thresholds live in
that one object.

### Inheritance: arrows and inherited blocks

**Arrows** go from a source to the canvas that inherits it. A canvas has at most one incoming arrow and any
number of outgoing ones.
- **Create:** each canvas has a connection handle (a ring at its top-right corner, on the row of its name).
  Drag it onto another canvas to make that canvas inherit this one, or tap it and then tap the canvas.
  While choosing, canvases that would make a loop are dimmed and valid ones are outlined in green.
- **Select:** tap an arrow (in the space between canvases; a press on a canvas always draws). Grips appear
  at both ends and a bar offers **Change source…** and **Delete arrow** (or the Delete key). Tap empty
  space or press Escape to deselect.
- **Retarget:** drag the selected arrow's **tail** onto another canvas to change the source (the block keeps
  its settings), or its **head** to move the arrow to another canvas (the canvas it leaves keeps an empty
  block). **Change source…** does the same by tapping, and so does the source picker in the block's properties.
- **Deleted source:** the inheritor's block is marked "source deleted" and shows a short red dashed stub
  on its left edge. Tap the stub, then tap the canvas to inherit from instead.
- **Opacity:** arrows are faint by default; full for the selected arrow and the arrows touching the
  selected canvas; medium for the rest of the selected canvas's chain (`ARROW_STYLE` in `src/config.ts`).
  **Arrows** in the toolbar hides or shows them all.
- **Lineage:** the selected canvas's chain upstream and every canvas depending on it downstream get a faint
  outline, and a badge above it says how many canvases depend on it.
- **Depth warning:** when a chain grows past 8 levels (`INHERITANCE_DEPTH_WARNING`), a banner says so. It
  never blocks.

Every arrow action is one undo step. Undoing a canvas deletion links its inheritors again.

**The inherited block** (layers panel, bottom row, dashed): a thumbnail, its state (*from <source>*,
*empty*, *source deleted*), opacity and blend mode, and ● to hide it. A canvas without a block offers
**Inherit from…** instead. Tap the row for its properties:
- **Source** picker (canvases that would make a loop are disabled) and **Go to** the source;
- **Opacity** (one undo step per drag) and **Blend**: normal, multiply, screen or overlay;
- **Placement**: *fit inside* (the default, refitted when the source changes) or *custom* (as soon as it is
  moved, scaled, rotated or flipped). Fields for position, scale % and rotation °, **Flip H** / **Flip V**,
  **Refit** (fit inside again), and **Transform** (below);
- **Crop** as % of the source (kept in normalized 0–1 coordinates, so it survives source resizes);
- **Effects**: grayscale, invert, posterize (with levels), applied in that order;
- **Remove inherited block** (deletes the block and its settings; undoable).

**Block-transform mode** (Transform in the block's properties): drag inside the block to move it, a corner
to scale it about its centre, or the round handle above it to rotate (snapping to 15° steps within 2°).
**Flip H**, **Flip V** and **Done** are in a bar at the bottom. While the mode is on, strokes are off and
presses elsewhere pan. Leave it with Done, the Transform button again ("Done transforming"), any tool in the
toolbar, or Escape / Enter. Each drag is one undo step.

### Memory settings

| Setting | Default | Where |
| ------- | ------- | ----- |
| Layer tiles kept on the GPU | 256 MB (1024 tiles of 256 × 256) | `LAYER_GPU_BUDGET_BYTES` in `src/config.ts`, or `?layerBudgetMB=` (16 to 512) |
| Composite cache | 1 full-resolution page + 2 preview pages (64 MB each) | `COMPOSITE_LEVEL0_PAGES`, `COMPOSITE_PREVIEW_PAGES` |
| Undo history | 256 MB, counted at raw tile size; the oldest steps are dropped first | `HISTORY_BUDGET_BYTES` |
| Tile ids (all canvases, layers and undo) | 65,536 | `MAX_TILE_IDS` |

When the GPU budget is full, the least recently used layer tiles leave the GPU. Since Phase 4 they go to
the open project's store on disk (a tile that is already saved needs no readback); only if writing fails
are they kept compressed in JS memory, as in Phase 2. They reload when a stroke, an undo, a resize or a recomposite needs them. Until then the
canvas shows its last composite or a coarser preview, so it never goes blank.

### URL parameters

- `?canvases=N` creates a new project with N A4 canvases in a grid (default: the last project opens; a new
  project has one 4096 × 4096 canvas).
- `?layerBudgetMB=N` sets the GPU budget for layer tiles.
- `?renderer=webgl2` forces the WebGL2 fallback.
- `?stress` adds stress mode to **Brush details & debug**:
  - **Build workspace**: N canvases (default 20) of a preset size, each with M layers (default 4) of
    S scripted strokes (default 6), in a grid to the right of the existing canvases;
  - **Auto-pan**: resets the stats, flies the view from canvas to canvas and back, then reports frame
    times, evictions and reloads during the pan, reload latency and peak GPU memory. Press
    **Export JSON** straight after to keep the details;
  - on the selected canvas: 200 strokes, fill 32 layers, and undo/redo all;
  - **Inheritance (Phase 3):** **Chain** (depth 1–10, default 5) builds a root and that many canvases, each
    inheriting the one before; **Fan-out** (1–20, default 10) builds a root and that many canvases all
    inheriting it. Inheritors get a mix of placements, effects, opacity and blend modes, and all stay on
    screen (1024 × 1024 canvases, right of the existing ones). Then **Root strokes** (default 10) scripted
    strokes are drawn on the root, each spread over about 12 frames like real input. The banner reports the
    change → end of chain time, frame times and p95 by depth. Each run is added to the JSON export.
  - **Persistence (Phase 4): Canvases × versions** creates a new project with the canvases set above
    (count, preset, layers, strokes), then **Versions** (default 20) manual versions with three strokes
    between them. The banner reports average save and version times, storage per version, the time to
    reopen the project until its previews show and until it is at full resolution, and garbage
    collection after deleting the older half of the versions. The details go to the JSON export.

**Brush panel:** size and opacity of the current tool (the brush and eraser have separate settings), and
finger drawing (Auto / On / Off). Under **Brush details & debug** are spacing, smoothing, the pressure
curve, pressure → size / opacity, "pressure from speed" for mouse and finger (faster = thinner; otherwise
they draw at full pressure), two-finger rotate, fit view, toggle HUD, export JSON and reset stats.

## Measurement HUD

The HUD shows the last 2 seconds and refreshes 4 times per second. Timing values are shown as `p50 / p95`.
Tap **▾ HUD** to collapse it to one line (fps, and the chain time while inheritors update), and tap again
to expand it; the choice is remembered on that device. Only that header takes taps: pen strokes pass
through the rest of the HUD.

| Line              | Meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `renderer`        | `WebGPU`, or `WebGL2` with the reason for the fallback                                                    |
| `fps`, `frame ms` | Interval between consecutive rendered frames. The app only renders when something changes, so it shows `idle` when nothing is happening |
| `render cpu ms`   | Main-thread time spent in `renderer.render()`                                                             |
| `samples/s`       | Pen samples per second, including coalesced samples (Apple Pencil should be about 240)                   |
| `events/s`        | `pointermove` events per second (roughly the display or input-dispatch rate)                             |
| `coalesced/evt`   | Average number of samples delivered per `pointermove`                                                     |
| `in→submit ms`    | Newest input sample's timestamp → this frame's GPU work submitted                                         |
| `oldest→submit`   | Same, measured from the oldest sample in the frame                                                        |
| `in→gpu done ms`  | Newest sample → GPU reports the work finished (`onSubmittedWorkDone`, WebGPU only)                        |
| `composite`       | Tiles recomposited per frame, composite CPU encode time, and composite GPU time (WebGPU with timestamp queries only) |
| counters          | Strokes, strokes ended by `pointercancel`, and touches ignored by palm rejection                          |
| `canvases`        | Canvases in the workspace, and the selected canvas's tiles and layers                                     |
| `tiles`           | Layer tiles in use (all canvases and undo), how many are on the GPU out of the budget (and their MB), and how many are compressed in JS memory (and their MB) |
| `visible canvases`| Canvases at least partly on screen in the last frame                                                      |
| `evictions … reloads` | Layer tiles moved off / back onto the GPU per second over the last second (totals in brackets)         |
| `reload ms`       | Time from asking for an evicted tile to its pixels being ready to upload (p50 / p95 of the last 200)    |
| `gpu memory`      | Estimate of the textures the app allocated (layer pages, composite pages, masks)                         |
| `undo memory`     | Undo/redo steps and the tiles only history keeps alive, counted at raw size                              |
| `chain ms`        | Phase 3: a source change reaching the renderer → the frame that brings the deepest inheritor fully up to date (its GPU work submitted). One value per frame that caught inheritors up |
| `inheritance`     | Phase 3: the selected canvas's chain depth; in the last frame, inheritors updated through an arrow and inheritors still stale (off screen during a stroke, or waiting for the budget) |
| `save`            | Phase 4: save status, requests waiting for the storage worker, and the last save that wrote something (ms from start to commit, bytes written) |
| `storage`         | Phase 4: this project's size on disk, the whole site's storage use (browser estimate, every 10 s), and the last garbage collection (ms, bytes freed) |

> **These latencies are estimates of software latency, not on-glass latency.** They start at the event's
> timestamp (when the browser received the input) and stop when our GPU work was submitted or completed.
> They leave out digitizer processing, compositor queuing and display scan-out. True pen-to-pixel latency
> is higher, and measuring it takes a high-speed camera.

### JSON export

**Export JSON** asks for a label (for example `webgpu lowpower-off tab`). On the iPad it opens the share
sheet (choose "Save to Files"). On desktop it downloads `measurements-<label>-<timestamp>.json`, which contains:

- `environment`: user agent, renderer and fallback reason, devicePixelRatio, CSS and backing sizes,
  coalesced/predicted event support, and whether the app is running as a home-screen app
- `brush`: the brush settings at export time
- `document`: layer/tile/slot counts, history steps and bytes, atlas pages and GPU memory
- `counters` and `summary`: the HUD statistics over the whole recording, not just the last 2 seconds
- `frames`: one record per rendered frame, with interval, CPU time, sample/event/dab counts, the
  latency estimates, visible canvases and running eviction/reload totals
- `residency`, `reloadTimes`: eviction/reload rates and every reload latency (ms)
- `memory`: four samples a second of tiles on the GPU, GPU bytes, compressed tiles and bytes, and undo memory
- `frames[].propagation`, `inheritorsUpdated`, `staleInheritors` (Phase 3): per frame, each inheritor
  caught up with its chain depth and time (ms); `inheritance` sums them up: `chainEnd`, `byDepth`, and
  `stressRuns` (one summary per Chain / Fan-out run: times by depth, frame times, peak GPU memory; and
  per persistence run, `kind: "persistence"`: save and version times, bytes per version, reopen times, GC)
- `persistence` (Phase 4): every save (ms, bytes and tiles written, records written, whether it committed)
  and every garbage collection (ms, files and bytes removed, project size after)

Press **Reset stats** before each test run so every file covers exactly one configuration.

## How it works

```
src/
  config.ts   sizes, memory budgets, gesture thresholds
  workspace/  Workspace (canvases + one history), coordinates, snapping, presets
  document/   tiles, ref-counted TileStore, PaintDocument + layers, blend maths, Editor, resize planning
  history/    Command interface, History (budgeted undo/redo), the commands
  app/        StrokeController (input → brush → GPU → undo step), composite state builder
  tools/      current tool, brush/eraser settings, recent colours
  input/      PenSample, pointer routing, finger drawing, two-finger navigation, taps/holds, wheel
  brush/      pressure (real or from speed), stabilizer, dab interpolation, StrokeEngine (pure logic)
  render/     Renderer interface, RenderCore (shared by both backends), pyramid planner, tile
              residency + compressed store, packing helpers, webgpu/ and webgl2/ backends
  ui/         toolbar, canvas labels, canvases panel, layers panel (+ block section), colour picker,
              arrows and arrow controls, block-transform mode, undo indicator, …
  viewport/   workspace ↔ screen transform
  debug/      metrics, HUD, controls, JSON export, stress mode
```

**Three coordinate spaces:** screen (CSS px), workspace (1 unit = 1 canvas pixel; canvases are placed in
it) and canvas (pixels of one canvas). `viewport/` maps screen ↔ workspace, a canvas's placement maps
workspace ↔ canvas. The renderer builds clip-space positions on the CPU in 64-bit floats, so drawing stays
exact far from the origin.

**Document model (CPU, no pixels):**
- A layer is a sparse map from tile key to *tile id*. Tiles are 256 × 256 and only exist where something
  was painted. Tiles are **immutable**: a stroke writes "old tile + stroke" into a new tile.
- Tile ids are reference-counted by `TileStore`, so an undo step just holds ids, and duplicating a layer
  or a canvas shares tiles.
- The `Workspace` holds the canvases in z-order and one undo history. Every command records its canvas.

**GPU:**
- **Layer tiles and residency.** A tile id is not a GPU location. `TileResidency` keeps the most
  recently used tiles in GPU slots (4096² atlas pages) within the budget. When it needs room it evicts the
  least recently used tile: the GPU copy is read back, deflate-compressed (`CompressionStream`) and kept by
  a `TileBackingStore` (Phase 4 can replace it with OPFS storage). Work that reads an evicted tile waits,
  in order, until it is reloaded. Each frame maps ids to the slots they occupy that frame.
- **Strokes.** While drawing, dabs go into a canvas-sized stroke mask and the compositor shows them on the
  active layer. On pen-up, each touched tile is copied into its new tile and the mask is blended on.
- **Composite pyramid.** Each canvas's composite is cached as 256² tiles at five levels: level 0 is full
  resolution and each level halves it (level 4 is a whole 4096 px canvas in one tile). Level 0 is
  composited from the layer tiles; coarser levels are box-filtered straight from level-0 tiles, so a
  changed tile only updates its small region of each cached level. The display draws the level that
  matches the zoom; levels 3–4 are kept for every canvas, so any canvas can always be shown, and a missing
  tile is drawn from the nearest coarser one. `PyramidPlanner` makes these decisions (pure, unit-tested)
  and both backends just execute its plan, a limited amount per frame.
- **Display and overlay.** One pass draws each visible canvas (a shadow, then its tiles) and then the
  overlay: arrows, lineage outlines, selection outline, undo highlight, block-transform outline. Overlay
  shapes are rects or rotated quads, sized in device pixels.
- **Batching.** Input handlers only queue work. `RenderCore` turns it into one frame's ops once per
  animation frame, and only when something changed.

**Data flow:** `PointerEvent` → `PenSample` → `StrokeEngine` (dabs) → `StrokeController` → renderer
(mask). On pen-up, `Editor.commitStroke` (new tiles + undo step) → `renderer.mergeStroke`. Workspace
change events tell the renderer which tiles to recomposite and which thumbnails to refresh.

### Inheritance (Phase 3)

- **Model.** `PaintDocument.inherited` holds at most one `InheritedBlock` (`src/document/inheritedBlock.ts`):
  its source (`linked`, `empty` or `missing`), placement (`fit` / `custom`: centre, scale, rotation, flips),
  normalized crop, effects, opacity, blend mode and visibility. Blocks are immutable values; every change
  makes a new one, so the renderer and undo just compare references. The pure maths (placement → affine
  matrix, dirty-rect transforms, fitting, crop) lives in the same file and is unit-tested.
- **Graph.** `InheritanceGraph` (`src/workspace/`) is built from the linked blocks. Before an arrow is made
  (create, retarget, relink), `wouldCycle` walks up from the new source; reaching the target refuses it.
  The graph is a forest, so order by depth is a valid topological order.
- **Undo.** `SetBlockCommand` covers every block change (create arrow, delete, retarget, relink, settings,
  remove), merging slider and handle drags into one step; `SetBlocksCommand` moves an arrow head (two
  blocks, one step). Deleting a canvas marks its inheritors' blocks *missing*, and undo restores them.
- **Propagation.** Composite changes are collected during a frame. At the start of the next frame
  `Propagation` maps each changed rect through every inheritor's crop and placement (grown one pixel for
  filtering), sources first, so each canvas gets one merged change and one `onCompositeChanged` event per
  frame. Inheritors are invalidated only in that rect.
- **Compositing.** The block is a source at the bottom of the compositor's stack: the shader maps each
  inheritor pixel back into the source, looks the source's cached composite tile up in a small lookup
  texture, samples it, applies effects, opacity and blend mode, then composites the canvas's own layers on
  top. The source level matches the block's size on screen (a small inheritor samples a preview level).
  An inheritor's cached composite includes its block, which is what its own inheritors sample. Canvases
  render in stages by depth, so a whole chain updates within one frame. Inheritors render into a staging
  texture and are copied to their cache slots, because a pass can't sample the page it renders into.
- **Budget and residency.** The planner spends its per-frame budget (a tile count) on sources before
  inheritors; among the same depth, canvases the budget skipped last frame go first. A visible inheritor
  asks for the parts of its source it shows, through the whole chain, so off-screen sources stay built;
  until a level is built, a coarser cached one is drawn, never a blank. During a stroke, inheritors that
  are off screen (and not needed by a visible one) are left *stale* and catch up when the stroke ends or
  they come into view.
- **Measurement.** The render core notes when a change arrived and which frame brings each inheritor up to
  date; `FrameInfo.propagation` carries those times with chain depths to the HUD and the export.

The Phase 2 hooks Phase 3 builds on (`onCompositeChanged`, `requestComposite`, `compositeTiles`, the overlay
pass, generic compositor sources) remain in the `Renderer` interface.

### Persistence (Phase 4)

- **Where.** `src/storage/` runs in a module worker (`storage.worker.ts`); the main thread talks to it
  through `StorageClient` (`client.ts`). Files live in OPFS, one folder per project
  (`projects/<id>/`), written with synchronous access handles. The project list and each project's
  *head* live in IndexedDB. Without OPFS or IndexedDB the app runs in memory and says nothing is saved.
- **Objects.** A tile is its raw premultiplied RGBA, hashed with SHA-256 and compressed (deflate); the file
  is named by the hash, with a 24-byte header (magic, codec, sizes, CRC32) so a torn write is detected and
  rewritten, never trusted (`objectCodec.ts`). Identical tiles are stored once. Fully transparent tiles
  are not stored at all. Canvas records (layers with their tile maps, the inherited block, previews) are
  stored the same way.
- **Two levels.** A root manifest (`manifests/<id>.json`, never rewritten) lists the canvases and points to
  each canvas's record by hash. The head (IndexedDB) points to the working manifest and lists the
  versions, each pointing to a manifest. Making a version copies nothing.
- **Commit sequence** (`projectStore.ts`): tiles → records → check that everything the manifest needs is
  on disk → write the manifest under a new name → replace the head in one IndexedDB transaction (the
  commit point, strict durability) → only then delete files nothing refers to. A crash at any step leaves
  the previous head complete; the tests crash at every step.
- **Saving on the main thread** (`src/persistence/`). `ProjectSaver` reads changed tiles back from the GPU
  asynchronously (a few per frame; WebGPU `mapAsync`, WebGL2 pixel buffer + fence), sends them to the
  worker, then sends the records of changed canvases only. `TileHashes` remembers each live tile's hash,
  so an unchanged tile is never read back again. `AutosaveScheduler` decides when to save (pure, tested
  with a fake clock). Hidden pages get no animation frames, so while hidden, frames are driven by a timer
  and the save skips previews.
- **Eviction to disk.** When the GPU budget is full, layer tiles now go to the project store
  (`DiskTileBackingStore`); a tile already saved leaves the GPU without a readback. JS memory holds no
  evicted tiles, unless writing fails (then they are kept compressed in memory as in Phase 2).
- **Previews.** Each canvas's composite levels 3–4 (1/8 and 1/16 resolution) are saved as tiles with its
  record. Opening a project installs them in the pyramid planner as complete tiles, so the workspace shows
  at once; layer tiles load as the view needs them.
- **Versions and retention** (`versions.ts`, `retention.ts`, pure and tested). Thumbnails are drawn on the
  CPU from the saved level-4 previews.
- **Garbage collection** (`gc.ts`, in the worker): mark everything the head's manifests reach plus the
  hashes the main thread still holds (undo history, evicted tiles, previews not committed yet), then sweep
  in short steps so saves carry on. Objects written during a collection are never swept.
- **Locks.** A Web Lock per project (`projectLock.ts`); without it the tab is read-only.
- **Format versions.** Every manifest, record and project file carries `formatVersion`; `migrations.ts`
  holds one step per version (one test migration, from a hand-written draft format 0).
- **Project files** (`archive.ts`): a zip (fflate) with `project.json`, manifests, and the stored objects
  as they are. Import checks paths and sizes, migrates and validates, verifies every hash, and always
  creates a new project. **PNG export** (`src/export/`) reads the canvas's full-resolution composite a few
  tiles per frame and streams it into a small PNG encoder a tile row at a time.

## Licence

MIT (see `LICENSE`). The one runtime dependency is [fflate](https://github.com/101arrowz/fflate) (MIT),
for zip files and PNG compression. The development tools are Vite, Vitest, TypeScript,
`@vitejs/plugin-basic-ssl`, `@webgpu/types` and `@types/node`, all MIT or BSD licensed.
