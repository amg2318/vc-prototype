# Phase 4 findings

**The measurements below were taken on a desktop, not an iPad.** They come from desktop Chrome on a Mac,
so they show whether the design works and where its costs are, not how an iPad will behave. The gate
("force-closing Safari mid-session loses at most the last stroke") can only be judged on the iPad: the
[on-device checklist](phase4-ipad-checklist.md) is the test.

## What was built

- **Storage:** content-addressed tiles and canvas records (SHA-256 of the raw premultiplied RGBA,
  deflate, a checksummed header) in OPFS, one folder per project, written by a storage worker; the
  project list and each project's head in IndexedDB.
- **Two-level format:** head → root manifest → canvas records → tiles. A commit writes tiles, then
  records, checks everything is on disk, writes a new manifest, then moves the head in one IndexedDB
  transaction. Files nothing refers to are removed only afterwards.
- **Autosave:** a 1.5 s debounce, an immediate save when a second stroke ends unsaved, and an immediate
  save when the page is hidden or closed. Strokes go on during a save.
- **Eviction to disk:** layer tiles that leave the GPU go to the project store, so JS memory no longer
  grows with the project. A tile already saved needs no readback.
- **Previews:** composite levels 3–4 saved per canvas and installed in the pyramid planner on open.
- **Versions:** manual (Save version, ⌘S), "Session ended", "after 30 min active time", "Before restore";
  thumbnails; restore; pin, rename, delete; retention.
- **Garbage collection:** mark and sweep in the worker, in short steps, protecting live tiles (undo
  history, evicted tiles) and anything written during the collection.
- **Projects:** create, open, rename, duplicate, delete; sizes and quota; last project on launch; Web
  Locks (a second tab is read-only).
- **Storage settings and errors:** persistence status and request, retention settings, storage-full
  handling with ways to make room, a notice in Safari tabs on iPad/iPhone.
- **Format versions and migrations:** `formatVersion` everywhere, a registry of steps, one test migration.
- **Export / import:** a `.vcproj` zip (placeholder name) with or without history; import validates,
  migrates, verifies every hash and creates a new project. PNG export per canvas at full resolution.
- **Measurement:** HUD `save` and `storage` lines; every save and GC in the JSON export; a
  "Canvases × versions" stress run.
- **Tests:** 423 unit tests in all (Phase 4 adds the codec, commit sequence with a crash at every step,
  migrations, retention, scheduler, saver, GC including undo-history tiles, session-level versions,
  restore and projects, archives, PNG).

## Desktop measurements

**Setup:** Mac, Chrome, 120 Hz display, development build (`npm run dev`). Times are wall-clock in the
page. Single runs unless noted, so treat them as orders of magnitude.

| What | Result |
| ---- | ------ |
| Save after one or two strokes on a 4096² canvas (9–26 tiles, 8–70 KB written) | 85–110 ms from start to commit |
| Save in the stress run (4 square canvases, 3 strokes between saves) | 110–190 ms, average 145 ms |
| Making a version once the working copy is saved (thumbnail + head update) | 10–14 ms |
| Storage per version (3 new strokes on one canvas) | 126–192 KB, average 150 KB |
| Reopening the stress project: to previews showing | 15 ms |
| … to full resolution (first canvas fitted, nothing left to load or composite) | 0.63 s |
| Save started by `visibilitychange` (page hidden, no animation frames) | committed 76 ms after the event |
| Garbage collection, small projects (0.5–1.6 MB) | 85–190 ms in total |
| PNG export of a 4096 × 4096 canvas (one layer, 72 tiles of strokes) | 1.4 s, 514 KB |
| Project export with history (0.4 MB) / import of the same file | 79 ms / 252 ms |

**Correctness checks done in the browser:**
- After a reload, every saved tile read back from the GPU was byte-identical to what was saved (SHA-256 of
  the readback equals the stored hash), on WebGPU (26/26 tiles) and WebGL2 (26/26), including
  semi-transparent pixels.
- A project reopened with zoomed-out canvases drew from its previews.
- Versions, restore (with "Before restore"), pin, rename, delete; duplicate, new, open, delete projects; a
  second tab read-only; a simulated `QuotaExceededError`, then "Delete automatic versions" and a successful
  retry; an export → import round trip with identical tiles and all versions.

## Problems found and fixed during the phase

- **A hidden page stalls its own save.** Browsers stop animation frames for hidden pages, and saving
  reads tiles back from the GPU in frames, so the save started on `visibilitychange` waited until the page
  came back: on the iPad, after a force-close, never. While hidden, frames are now driven by a timer, and
  that save skips the previews (they are refreshed later). This was the biggest risk to the gate found on
  the desktop.
- **Reopening a project came back read-only.** Releasing a Web Lock is asynchronous; asking for it again
  at once failed. The lock is now kept when reopening the same project, and releasing waits until it is
  free.
- **Found on the iPad (first test): the app opened read-only although no other tab was open.**
  Two causes:
  - A new project's first save waited for previews, which need frames, and frames only start once the
    app has started. So the first launch on a new device (or `?canvases=N`) hung while holding the
    project's lock.
  - A page kept in the back/forward cache keeps its Web Lock, so any later page opened the project
    read-only.

  Fixes:
  - The first save of a new project leaves its previews to the next save.
  - On `pagehide` into the cache, the page lets go of the lock (and takes it back, read-only until then,
    if restored).
  - Opening waits up to 2 s for the lock.
  - A read-only tab waits in the background and reloads the project with saving on once no other page
    has it.

  Checked in desktop Chrome: a page navigated away from let go of its lock, and the waiting tab took over
  within 2 s. Restoring from the cache with Back was not tried.
- **Found on the iPad: PNG export of an inheriting canvas never finished.** The level an inherited
  block is built at followed only what the screen needed. For a canvas off screen or zoomed out, the
  export's tiles were built at low resolution and then dropped as such, over and over. Export now
  counts as a full-resolution need for the canvas and its sources. Checked in desktop Chrome on WebGPU
  and WebGL2 (an A4 canvas inheriting another, zoomed out: correct PNG, the same on both).
- **Sizes drifted** when files were removed after the head moved; the size recorded with the head now
  already leaves them out, and garbage collection recounts from the files.

## Known issues and risks for the gate

- **At most two strokes, not one, can be lost in one case.** The second-stroke rule starts a save when a
  second stroke ends unsaved. If the app is killed *during* that save (about 100–200 ms on the desktop,
  probably longer on the iPad), both strokes are lost. A stroke in progress when the app is killed is
  never saved either (as the gate allows). Saving after *every* stroke would close this, at the cost of
  more writes; the checklist's case b measures how often it happens.
- **What iPadOS allows after the app is swiped away is not known yet.** The save on hiding needs the page
  to keep running for a few hundred milliseconds (GPU readback, hashing, writing, an IndexedDB
  transaction). If Safari suspends the page sooner, the strokes since the last save are lost. The
  checklist's case d (background first, then close) separates this from a plain kill.
- **Durability of OPFS writes on iPadOS** (synchronous access handle `flush()`) and of IndexedDB's strict
  durability after a force-close are assumed, not verified.
- **A WebGPU device in a hidden page:** whether iPadOS keeps the GPU queue running for a hidden tab is
  unverified. If not, the save on hiding can't read tiles back. Tiles saved earlier (most of them) are
  unaffected.
- **Exports are built in memory** (the whole zip in the worker, the whole file handed to the share sheet).
  Large projects may run out of memory on an iPad. PNG export streams, so its memory doesn't grow with the
  canvas.
- **Saves wait during an export of the open project** (it is read inside the project's lock).
- **A page frozen in the back/forward cache mid-save** lets go of its lock; if another tab opens the
  project and the frozen page is restored, its unfinished save can still land on top of the other tab's
  head. Rare, not handled.
- **Read-only tabs keep evicted tiles in memory**, since the owning tab's garbage collection doesn't know
  about them.
- **The size shown per project counts our files**, not the file system's overhead; the browser's estimate
  (also shown) is larger.
- **Safari's 7-day storage limit for sites in a tab** is the reason for the home-screen notice; how the
  limit applies to OPFS on current iPadOS is not verified.

## Not done in this phase

As agreed in the spec: no cloud sync, accounts, collaboration, branching or comparing versions, PSD/PDF
export or final design. The project file extension is a placeholder.
