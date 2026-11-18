# VC Prototype: Phase 0 (feasibility spike)

A tablet-first web drawing tool, combining Procreate-style raster painting with Figma-style multi-canvas
layout. **Phase 0 answers one question:** does pressure-sensitive drawing feel good enough in Safari on iPad
with Apple Pencil?

This phase is deliberately small: one 2048 × 2048 document, one round brush, pan/zoom, a measurement HUD
and a PWA shell. Layers, tiles, undo, saving and multiple canvases are out of scope.

- [On-device test checklist](docs/ipad-checklist.md): what to try on the iPad and which numbers to record
- [Phase 0 findings](docs/phase0-findings.md): desktop measurements, known issues and concerns

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

| Input                         | Action                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| Apple Pencil / pen            | Draw (pressure → size and opacity)                            |
| Pen eraser end (Wacom etc.)   | Erase (paints white; there are no layers yet)                 |
| Mouse, left button            | Draw at full pressure                                         |
| Two fingers                   | Pan and pinch-zoom (rotation: tick "Two-finger rotate")       |
| One finger                    | Nothing, so a resting finger or palm never moves the canvas   |
| Mouse wheel / trackpad pinch  | Zoom at the cursor                                            |
| Middle-drag, or Space + drag  | Pan                                                           |
| `h`                           | Toggle HUD                                                    |

**Palm rejection:** while the pen is down, all touch input is ignored. If two touches (a palm) had already
started a pinch when the pen lands, the view snaps back to where it was before that pinch.

**URL parameters:** `?renderer=webgl2` forces the WebGL2 fallback, and `?renderer=webgpu` is the default
behaviour.

**Debug panel:** brush size (document px), opacity, dab spacing (fraction of diameter), smoothing, pressure
curve preset (`linear`, `soft`, `firm`, `sCurve`), pressure → size / opacity toggles, colour, two-finger
rotate, clear canvas, fit view, toggle HUD, export JSON and reset stats.

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
| counters          | Strokes, strokes ended by `pointercancel`, and touches ignored by palm rejection                          |

> **These latencies are estimates of software latency, not on-glass latency.** They start at the event's
> timestamp (when the browser received the input) and stop when our GPU work was submitted or completed.
> They leave out digitizer processing, compositor queuing and display scan-out. True pen-to-pixel latency
> is higher, and measuring it takes a high-speed camera.

### JSON export

**Export JSON** asks for a label (for example `webgpu lowpower-off tab`). On the iPad it opens the share
sheet (choose "Save to Files"). On desktop it downloads `phase0-<label>-<timestamp>.json`, which contains:

- `environment`: user agent, renderer and fallback reason, devicePixelRatio, CSS and backing sizes,
  coalesced/predicted event support, and whether the app is running as a home-screen app
- `brush`: the brush settings at export time
- `counters` and `summary`: the HUD statistics over the whole recording, not just the last 2 seconds
- `frames`: one record per rendered frame, with interval, CPU time, sample/event/dab counts and the
  latency estimates

Press **Reset stats** before each test run so every file covers exactly one configuration.

## How it works

```
src/
  input/      PenSample type, pointer routing, two-finger gestures, browser-gesture blocking
  brush/      pressure curve, stabilizer, dab interpolation, StrokeEngine (all pure logic)
  render/     Renderer interface, shared CommandQueue, webgpu/ and webgl2/ backends
  viewport/   document ↔ screen transform, zoom/pinch/fit math
  debug/      metrics, HUD, controls, JSON export
  pwa/        service worker template and registration
  main.ts     wires everything together
```

**Data flow:** `PointerEvent` → `PenSample` (document coordinates, every coalesced sample) →
`StrokeEngine` (stabilizer → pressure curve → size/opacity → evenly spaced dabs) → `Renderer`.
Predicted samples go through copies of the stabilizer and interpolator, so they never change the real
stroke.

**Rendering model:**

- **Textures.** There are three document-sized textures: the document (`rgba8`), a stroke mask (`r8`) and a
  prediction mask (`r8`).
- **Stamping.** Dabs are stamped into the masks as instanced quads with MAX blending, so overlapping dabs
  keep the highest coverage instead of building up opacity.
- **Display.** Each frame draws the document through the viewport matrix and mixes the live stroke mask on
  top.
- **Merge.** When the stroke ends, the mask is composited into the document once, at the stroke's opacity.
  The prediction mask is cleared and redrawn every frame.
- **Batching.** Input handlers only queue work. `render()` runs once per animation frame, and only when
  something has changed.

**Coordinates:** all brush and document logic works in document pixels. The viewport transform
(`scale`, `rotation`, `tx`, `ty`) is the only link to the screen, so later phases can give each canvas in
the workspace its own document space.

**Renderer interface:** the interface is deliberately narrow (`beginStroke`, `addStrokeDabs`,
`setPredictedDabs`, `endStroke`, `clearDocument`, `render`) so that tiling and layers can change the
internals later without touching input or brush code.

## Licence

MIT (see `LICENSE`). The only dependencies are development tools: Vite, Vitest, TypeScript,
`@vitejs/plugin-basic-ssl`, `@webgpu/types` and `@types/node`. All are MIT or BSD licensed. The shipped app
has no runtime dependencies.
