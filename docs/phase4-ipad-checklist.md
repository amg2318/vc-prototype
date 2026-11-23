# Phase 4 on-device checklist (iPad + Apple Pencil)

**Gate:** force-closing Safari mid-session on the iPad loses at most the last stroke.

Fill in one copy per device. Test in a Safari tab first, then as a home-screen app (from the GitHub Pages
URL): the two may behave differently when the app is closed. Keep the HUD open: its `save` line shows
the save status, the requests waiting for the storage worker, and the last save's time and size.
Nothing here has been tried on an iPad yet; the desktop results are in
[phase4-findings.md](phase4-findings.md).

## Device

| Field                                       | Value |
| ------------------------------------------- | ----- |
| iPad model and RAM                          |       |
| iPadOS / Safari version                     |       |
| Pencil model                                |       |
| HUD `renderer` line                         |       |
| Safari tab or home-screen app               |       |
| Low Power Mode off, charger connected       |       |

## 1. The gate: force-close mid-session

For each case, draw numbered strokes (1, 2, 3 …: a short digit each) so you can tell afterwards exactly
which strokes came back. Then force-close: swipe up from the bottom, hold to open the app switcher, and
swipe the app (or Safari) away. Reopen it and count.

| Case | How | Strokes drawn | Strokes back after reopening | Lost (should be 0 or 1) | WebGPU | WebGL2 (`?renderer=webgl2`) |
| ---- | --- | ------------- | ---------------------------- | ----------------------- | ------ | --------------------------- |
| a | Draw 5 strokes slowly (wait 2 s after each), then force-close at once | 5 | | | | |
| b | Draw 10 strokes fast (hatching), force-close right after the last | 10 | | | | |
| c | Draw a stroke and force-close **while the pen is still down** (other hand) | | | | | |
| d | Draw 3 strokes, press the Home gesture (app to background), wait 10 s, then force-close from the switcher | 3 | | | | |
| e | Draw on a canvas with many layers / a large canvas (stress `Build workspace` first) | | | | | |
| f | Same as b, in a Safari tab (if the rest was in the home-screen app) or the other way round | 10 | | | | |

Notes for the findings (did the indicator say *Saved* before closing? how long does a save take in the HUD?):

## 2. Reopening

| Check | Result |
| ----- | ------ |
| The last opened project opens on launch | |
| Every canvas shows at once from its previews when zoomed out (before layers load) | |
| Zooming in, the full-resolution content appears (how long?) | |
| The camera is where it was | |
| Undo history is empty after reopening (expected) | |

## 3. Versions

| Check | Result |
| ----- | ------ |
| ⌘S (with a keyboard) and **History → Save version** each make a version; the banner names it | |
| The thumbnail shows the newest stroke | |
| Draw after the last version, close, reopen: a "Session ended …" version appears | |
| Restore an old version: the canvas changes, a "Before restore …" version appears, the banner explains, undo is empty | |
| Restore the "Before restore" version: the newer state is back | |
| Pin, rename, delete (asks again) | |
| HUD `save` / `storage` lines while doing this (save ms, project size) | |

## 4. Projects and storage

| Check | Result |
| ----- | ------ |
| **Projects → New project**, draw, switch back and forth: each keeps its own canvases and versions | |
| Duplicate, rename, delete (asks again); deleting the open project opens another | |
| Sizes per project, and "this site uses … of … available" (write down the quota) | |
| Storage on this device: what does the persistence line say? Does "Ask to keep them" change it? | |
| In a Safari tab: the "use the Home Screen app" notice appears once per visit (not in the home-screen app) | |
| Open the same project in two Safari tabs: the second says read-only, its indicator says *Read-only* | |
| Then close the first tab: within a few seconds the second says it reloaded the project and saves now | |
| Projects → Storage → **Delete all data…** (tap twice): the app reloads with one empty project and says everything was deleted | |
| First launch on a device with no projects (or after deleting them all): the app starts, not read-only | |

## 5. Export, import, PNG

| Check | Result |
| ----- | ------ |
| Export a project with history: the share sheet opens; "Save to Files" works; file size | |
| Delete that project, then **Import…** the file: it comes back as a new project with its versions | |
| Export without history, import: only the working copy | |
| Canvases → **Export PNG** on a canvas that inherits another, zoomed out and with it off screen: the PNG shows the inherited content; time for a 4096² canvas | |
| If the share sheet did not open after a long export, did the **Save…** button work? | |
| Share a PNG to another app (Photos, Mail…) | |

## 6. Stress (`?stress`)

In **Brush details & debug → Persistence: Canvases × versions** (default 20 canvases × 20 versions; try
5 × 20 first). Press **Export JSON** right after each run.

| Record | Small (5 × 20, Square) | Default (20 × 20, A4) |
| ------ | ---------------------- | --------------------- |
| Banner: save ms, version ms | | |
| Banner: storage per version | | |
| Banner: reopen to previews / to full resolution (ms) | | |
| Banner: GC ms, freed | | |
| HUD `gpu memory` and `tiles` during the run | | |
| Did anything stall, crash or reload the page? | | |
| Export JSON label | | |

## 7. Anything else

Crashes, page reloads by Safari, slow saves, strokes that came back wrong, storage warnings:
