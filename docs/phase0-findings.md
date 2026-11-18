# Phase 0 findings (desktop only, before any iPad testing)

Everything below was measured on a desktop. **Nothing here is an iPad result.** The iPad numbers will come
from [the on-device checklist](ipad-checklist.md).

## Setup

- MacBook with an Apple M5 and a 3024 × 1964 Retina display
- Google Chrome 157, driven headlessly by Playwright, with WebGPU enabled
- Viewport 1180 × 820 CSS px (iPad Air size) at devicePixelRatio 2, so the canvas backing store is
  2360 × 1640
- Input was injected through the Chrome DevTools Protocol as `pointerType: "pen"` with varying pressure
  and tilt, and as a mouse. **Synthetic input is not representative of real pen timing** (see below).

## What was verified

| Check                                                                 | WebGPU | WebGL2 |
| --------------------------------------------------------------------- | ------ | ------ |
| Renderer starts; `?renderer=webgl2` forces the fallback               | ✅     | ✅     |
| Pen pressure drives size and opacity; mouse draws at full pressure    | ✅     | ✅     |
| 40% opacity strokes stay even (no build-up where dabs overlap)        | ✅     | ✅     |
| Both backends produce visually identical output                       | ✅     | ✅     |
| Wheel zoom at the cursor, middle-drag and Space+drag pan (no drawing) | ✅     | ✅     |
| Two-finger pinch (CDP touch): 3× finger spread → 3× zoom              | ✅     |        |
| One-finger touch neither draws nor navigates                          | ✅     |        |
| Touches while the pen is down are ignored and counted                 | ✅     |        |
| A palm "pinch" before the pen lands is reverted                       | ✅     |        |
| JSON export downloads and parses                                      | ✅     | ✅     |
| Built app under `/vc-prototype/` works offline after the first load   | ✅     |        |
| HTTPS dev server reachable on the LAN address                         | ✅     |        |
| 59 unit tests pass; strict TypeScript has no errors                   | ✅     |        |

## Measurements

Stress run: 12 fast pen strokes, brush 200 px, spacing 5%, opacity 50%, about 300 rendered frames.
Values are p50 / p95 / max in milliseconds.

| Metric                 | WebGPU             | WebGL2             |
| ---------------------- | ------------------ | ------------------ |
| Frame interval         | 16.7 / 16.7 / 50.0 | 16.7 / 16.7 / 16.7 |
| `render()` CPU time    | 0.20 / 0.30 / 0.60 | 0.10 / 0.20 / 0.30 |
| Input → submit         | 15.7 / 16.9 / 17.5 | 16.0 / 16.9 / 17.1 |
| Input → GPU done       | 18.3 / 20.1 / 23.3 | n/a                |
| Dabs per frame         | p50 6, max 20      | p50 6, max 20      |

How to read these numbers:

- **The rendering cost is negligible on this hardware.** The `render()` CPU time stays under 1 ms. GPU
  work completes about 2–3 ms after submit.
- **The ~16 ms input→submit is mostly an artifact of the test setup.** CDP delivers each synthetic
  event just after a frame, so every event waits almost a full frame for the next `requestAnimationFrame`.
  With real hardware, browsers deliver input aligned to frames, just before `requestAnimationFrame`, so
  the value should be much lower. It may still not be zero, and the iPad run will show how far it drops.
- **The single 50 ms WebGPU frame happened once.** The likely causes are first-use costs such as the
  pipeline and dab buffer warming up. I have not confirmed the cause.
- **Synthetic input gives one sample per event** (`coalesced/evt` = 1.0), so coalescing was not exercised.
  With Apple Pencil at 240 Hz and a 60/120 Hz display, expect about 2–4 samples per event.

## Known issues and limitations

1. **No mipmaps.** When zoomed out below about 50%, thin strokes alias and shimmer while panning. When
   zoomed in, linear filtering blurs the pixels. This doesn't affect the drawn pixels, only how they are
   shown. It can be fixed later, alongside tiling.
2. **The masks are 8-bit.** Very low opacities and very soft edges are quantised to 1/255 steps. This could
   show up as banding at low flow.
3. **MAX blending means a single stroke never darkens itself.** This is intended (it's the "no build-up"
   requirement). Overlapping separate strokes do build up, as expected. Marker-style self-build-up would
   need a different blend mode.
4. **The eraser paints white**, because there are no layers yet.
5. **Stroke ends.** The `pointerup` sample is dropped because it reports pressure 0. With high smoothing
   the stroke catches up to the pen position with a short straight segment.
6. **A `pointercancel` keeps the stroke** instead of discarding it, and the HUD counts it. If iPad testing
   shows many cancellations, that points to Safari gesture interference.
7. **WebGL2 has no GPU-done timing.** Adding one would mean polling `fenceSync` every frame.
8. **The HUD updates the DOM 4 times per second.** That is cheap on desktop. On the iPad, compare the feel
   with the HUD on and off.
9. **`npm audit` reports a high-severity ReDoS advisory in `picomatch`.** It reaches the project through
    Vite and Vitest, so it affects the development and build tooling only. Nothing from it ships to the
    browser. No fix is available without downgrading Vite.
10. **I chose the MIT licence as a default** for an open-source thesis project. Change `LICENSE` if you
    prefer another.

## Concerns for the Phase 0 gate

These are the things most likely to decide "acceptable in Safari on iPad". In rough order of risk:

1. **Frame rate on ProMotion iPads.** Safari has historically limited `requestAnimationFrame` to 60 Hz on
   120 Hz iPads, unless a Safari feature flag was changed. I'm not certain what Safari 26 does. If it is
   still limited to 60 Hz, ink trails the Pencil by at least one extra 8 ms frame compared with native
   120 Hz apps, and fast strokes will visibly lag. The HUD `fps` line answers this directly. This is the
   most important number to record.
2. **Predicted events in Safari.** Prediction is the main tool for hiding latency. I'm not sure Safari
   implements `getPredictedEvents()`. If the HUD shows `predicted no`, the app still works, but we would
   need our own extrapolation (for example from the last few coalesced samples' velocity) to get closer to
   native feel. That would be a small addition inside `StrokeEngine.predict`.
3. **Native apps have a structural advantage.** Procreate and Notes use Apple's low-latency drawing
   paths and PencilKit's prediction. A web app goes through Safari's compositor and adds at least one
   frame. The realistic target is "acceptable", not "matches Procreate". A side-by-side slow-motion video
   is the honest way to quantify the gap.
4. **Self-signed certificate behaviour.** I expect WebGPU to work after tapping through the warning, but
   I couldn't verify how Safari treats that page. If it falls back to WebGL2 and mentions a secure
   context, use the mkcert setup or the GitHub Pages build.
5. **Safari gesture leaks.** Edge swipes, Scribble and Pencil double-tap are partly controlled by the
   system, not the page. `touch-action: none` and cancelling touch events cover the documented cases, but
   only the device can tell us whether anything still leaks through.
6. **Low Power Mode** throttles the display to 60 Hz and may also throttle the GPU. Expect worse numbers,
   and decide whether the gate should require acceptable feel in Low Power Mode too.
