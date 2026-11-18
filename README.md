# VC Prototype: Phase 1 (painting core)

A tablet-first web drawing tool, combining Procreate-style raster painting with Figma-style multi-canvas
layout. **Phase 1 gate:** a finished sketch can be drawn on one canvas on an iPad, with no crashes.

Phase 1 adds the painting core on a single 4096 × 4096 canvas:
- tiled layers (up to 32) with opacity, visibility and blend modes (normal, multiply);
- an eraser to transparency;
- undo/redo with a memory budget;
- a layers panel, colour picker and eyedropper;
- touch gestures and keyboard shortcuts.

Saving and multiple canvases are later phases.

- [Phase 1 on-device checklist](docs/phase1-ipad-checklist.md): what to try on the iPad
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
| Mouse, left button                 | Use the current tool at full pressure                             |
| Two fingers                        | Pan and pinch-zoom (rotation: tick "Two-finger rotate")           |
| Two-finger tap / three-finger tap  | Undo / redo                                                       |
| One finger, touch and hold         | Eyedropper (samples what you see: all visible layers + background) |
| One finger, eyedropper tool selected | Pick straight away; a second finger cancels the pick and pinches |
| Mouse wheel / trackpad pinch       | Zoom at the cursor                                                |
| Middle-drag, or Space + drag       | Pan                                                               |

| Key                       | Action                       |
| ------------------------- | ---------------------------- |
| ⌘Z / Ctrl+Z               | Undo                         |
| ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y | Redo                       |
| B / E / I                 | Brush / eraser / eyedropper  |
| [ / ]                     | Smaller / larger tool size   |
| ⇧N                        | New layer                    |
| H                         | Toggle HUD                   |

**Toolbar:** brush, eraser, eyedropper, colour (opens the HSV picker with recent colours), undo, redo,
layers.

**Layers panel:** the top layer is listed first. Tap a row to select it. Use ● to show or hide a layer, and
drag ≡ to reorder. The selected layer shows its opacity (one undo step per slider drag), blend mode, rename,
duplicate, clear and delete. **Background** sets the paper colour, which the eraser never removes.

**Palm rejection:** while the pen is down, all touch input is ignored. If a palm had already started a
pinch when the pen lands, the view snaps back. Touches with a large contact area
(`GESTURES.palmContactPx` in `src/config.ts`) never count as taps or holds. All gesture thresholds live in
that one object.

**Memory limits:** tiles come from a fixed pool of 2048 tiles (512 MB). Undo history may use up to 256 MB
of it, and the oldest steps are dropped first. If the drawing itself fills the pool, the stroke is refused
and a banner explains why.

**URL parameters:**
- `?renderer=webgl2` forces the WebGL2 fallback.
- `?stress` adds stress tests to the debug section: 200 strokes, fill 32 layers, undo/redo all, and fill the
  pool.

**Brush panel:** size and opacity of the current tool (the brush and eraser have separate settings). Under
**Brush details & debug** are spacing, smoothing, the pressure curve, pressure → size / opacity,
two-finger rotate, fit view, toggle HUD, export JSON and reset stats.

## Measurement HUD

The HUD shows the last 2 seconds and refreshes 4 times per second. Timing values are shown as `p50 / p95`.

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
| `tiles … slots … pages` | Tile entries in the document, used/total pool slots (document + history), allocated atlas pages |
| `gpu memory`      | Estimate of the textures the app allocated (atlas pages, masks, composite cache)                         |
| `history`         | Undo/redo steps and the pool memory that only history keeps alive                                        |

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
- `frames`: one record per rendered frame, with interval, CPU time, sample/event/dab counts and the
  latency estimates

Press **Reset stats** before each test run so every file covers exactly one configuration.

## How it works

```
src/
  config.ts   canvas size, tile size, layer/pool/history limits, gesture thresholds
  document/   tiles, ref-counted TileStore, PaintDocument + layers, blend maths, Editor
  history/    Command interface, History (budgeted undo/redo), the commands
  app/        StrokeController (input → brush → GPU → undo step), composite state builder
  tools/      current tool, brush/eraser settings, recent colours
  input/      PenSample, pointer routing, two-finger navigation, tap/hold recogniser
  brush/      pressure curve, stabilizer, dab interpolation, StrokeEngine (pure logic)
  render/     Renderer interface, FrameQueue, packing helpers, webgpu/ and webgl2/ backends
  ui/         toolbar, layers panel, colour picker, thumbnails, loupe, shortcuts
  viewport/   document ↔ screen transform
  debug/      metrics, HUD, controls, JSON export, stress tests
```

**Document model (CPU, no pixels):**
- A layer is a sparse map from tile key to *tile slot*. Tiles are 256 × 256 and only exist where something
  was painted.
- Slots are reference-counted by `TileStore`. Tiles are **immutable**: a stroke never changes a tile in
  place. It writes "old tile + stroke" into a fresh slot.
- An undo step therefore just holds references to the old slots. Undo and redo swap references, and
  duplicating a layer shares its tiles.
- Every command carries a `canvasId`, ready for multiple canvases.

**GPU:**
- **Tile pool.** Slots live in 4096² `rgba8` atlas pages (256 tiles, 64 MB each), allocated on demand up to
  8 pages. Pixels are 8-bit premultiplied alpha throughout.
- **Strokes.** While drawing, dabs go into a canvas-sized stroke mask and the compositor shows them on the
  active layer. On pen-up, each touched tile is copied into its new slot and the mask is blended on: source-over
  to paint, destination-out to erase.
- **Freeing erased tiles.** After an eraser stroke, a small GPU reduction finds tiles that became fully
  transparent so they can be freed.
- **Compositor.** One instanced draw over the dirty tiles. Per pixel, it starts with the paper colour and
  blends each visible layer's tile (found through a tile lookup texture) with that layer's opacity and blend
  mode. The result is cached in a canvas-sized texture, and only dirty tiles are recomposited.
- **Display.** The display pass draws the cache through the viewport and box-filters it when zoomed out.
- **Batching.** Input handlers only queue work in a `FrameQueue`, which is drained once per animation frame.

**Data flow:** `PointerEvent` → `PenSample` → `StrokeEngine` (dabs) → `StrokeController` → renderer
(mask). On pen-up, `Editor.commitStroke` (new slots + undo step) → `renderer.mergeStroke`. The editor's
change events tell the renderer which tiles to recomposite and which thumbnails to refresh.

**Phase 3 hook:** the compositor takes a list of generic *sources*, not layers. That way, inherited content
from other canvases can later be added as extra sources at the bottom.

## Licence

MIT (see `LICENSE`). The only dependencies are development tools: Vite, Vitest, TypeScript,
`@vitejs/plugin-basic-ssl`, `@webgpu/types` and `@types/node`. All are MIT or BSD licensed. The shipped app
has no runtime dependencies.
