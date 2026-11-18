# Phase 0 on-device checklist (iPad + Apple Pencil)

**Gate:** drawing feels acceptable in Safari on iPad.

Fill in one copy of this checklist per device. Before every measured run, press **Reset stats**. After the
run, press **Export JSON** with a label that describes the configuration.

## Device

| Field                                       | Value |
| ------------------------------------------- | ----- |
| iPad model                                  |       |
| iPadOS version                              |       |
| Display refresh rate (60 Hz or 120 Hz ProMotion) |       |
| Pencil model (1st gen / 2nd gen / USB-C / Pro) |       |
| How the app was opened (dev URL / Pages URL)|       |

## 1. Startup

- [ ] The HUD's first line reads `WebGPU`. If it reads `WebGL2 (fallback: …)`, copy the reason here: ______
- [ ] The HUD shows `coalesced yes` / `predicted yes`. Note any `no`: ______
- [ ] The document fills the screen with a margin, and the HUD shows `dpr 2`.

## 2. Drawing feel

Use the default brush (24 px, linear curve, 15% smoothing). Rate each row 1–5 and add a note.

| Test                                                         | 1–5 | Notes |
| ------------------------------------------------------------ | --- | ----- |
| Slow lines (handwriting speed)                               |     |       |
| Fast lines and scribbles                                     |     |       |
| Light pressure: thin, faint lines that don't break up        |     |       |
| Heavy pressure: thick, dark lines without blobs               |     |       |
| Pressure ramp (light → heavy → light in one stroke)           |     |       |
| Stroke starts: no blob, gap, or hook at pen-down             |     |       |
| Stroke ends: no hook, flick or straight "catch-up" tail      |     |       |
| Gap between the pen tip and the ink while moving fast        |     |       |
| Predicted segment: no visible overshoot or flicker           |     |       |
| Pressure curves `soft` / `firm` / `sCurve`: which feels best? |     |       |
| Smoothing at 0% vs 15% vs 50%                                |     |       |
| 40% opacity: no darker spots where a stroke overlaps itself  |     |       |
| Large brush (150–200 px) drawn quickly: still smooth?        |     |       |
| Zoomed in to 400%+ while drawing                             |     |       |
| Overall: is this acceptable for real drawing? (y/n)          |     |       |

## 3. Palm rejection and navigation

- [ ] Rest your palm on the screen, then draw. No stray marks, and the canvas doesn't move.
- [ ] Rest your palm while drawing. The `palm-rejected` counter goes up and nothing else happens.
- [ ] Two-finger pan and pinch are smooth and follow your fingers, with no jumps when you start or end.
- [ ] Two-finger rotate (after ticking the checkbox) works.
- [ ] One finger does nothing.
- [ ] Drawing straight after a pinch works (the first stroke isn't lost).
- [ ] The `cancelled` counter stays at 0. If it goes up, note what you were doing: ______

## 4. Safari interference

Try each action several times, on the canvas and near the screen edges.

| Behaviour                                                       | Ever happened? | When |
| --------------------------------------------------------------- | -------------- | ---- |
| Page zoom (pinch or double-tap zooms the whole page)            |                |      |
| Text selection or highlight appears                             |                |      |
| Long-press callout, magnifier or loupe                          |                |      |
| Scribble activates (handwriting turns into text, or a Scribble toolbar appears) |                |      |
| Page scrolls or rubber-bands                                    |                |      |
| Swipe from the edge triggers Back/Forward, the app switcher or Control Centre while drawing |                |      |
| Pencil double-tap or squeeze causes a browser action            |                |      |

## 5. Measurements

For each configuration: press **Reset stats**, then draw continuously for about 30 seconds (a mix of slow,
fast, light and heavy strokes). Read the HUD *while drawing*, then press **Export JSON**.

| # | Renderer | Low Power Mode | Context        | fps | frame ms p50/p95 | samples/s | coalesced/evt | in→submit p50/p95 | in→gpu done p50/p95 | Feel (1–5) | JSON label |
|---|----------|----------------|----------------|-----|------------------|-----------|---------------|-------------------|---------------------|------------|------------|
| 1 | WebGPU   | off            | Safari tab     |     |                  |           |               |                   |                     |            |            |
| 2 | WebGL2   | off            | Safari tab     |     |                  |           |               |                   | —                   |            |            |
| 3 | WebGPU   | **on**         | Safari tab     |     |                  |           |               |                   |                     |            |            |
| 4 | WebGL2   | **on**         | Safari tab     |     |                  |           |               |                   | —                   |            |            |
| 5 | WebGPU   | off            | Home-screen app|     |                  |           |               |                   |                     |            |            |
| 6 | WebGL2   | off            | Home-screen app|     |                  |           |               |                   | —                   |            |            |

How to switch configurations:

- **WebGL2:** add `?renderer=webgl2` to the URL. For the home-screen app, add a second home-screen icon
  while that URL is open.
- **Low Power Mode:** Settings → Battery → Low Power Mode. It usually caps the display at 60 Hz, so expect
  the fps to drop on ProMotion iPads.
- **Home-screen app:** open the GitHub Pages URL, tap Share → Add to Home Screen, then launch it from the
  icon. The HUD should say `home-screen app`.

Also check:

- [ ] With the HUD toggled off (`Toggle HUD`), does drawing feel any different?
- [ ] On a 120 Hz iPad, does `fps` reach about 120 or stay at about 60? (This matters a lot; see the findings note.)
- [ ] Offline: in the home-screen app, turn on Airplane Mode, force-quit the app and relaunch it. Does it still open?

## 6. What to send back

- This checklist, filled in
- The JSON files from section 5
- Optionally, a slow-motion video (240 fps) of a fast stroke, filmed side by side with the same stroke in
  Procreate or Notes. This is the only way to see true on-glass latency.
