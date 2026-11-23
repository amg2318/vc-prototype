# Task: Build Phase 4 (persistence and version history)

## Context
This repo contains Phases 0–3 of my thesis project: a free, open-source, tablet-first web
drawing tool. Phase 3 works: an infinite workspace of canvases with tiled layers (256 × 256,
premultiplied alpha), workspace-wide undo, previews/LOD, tile residency with eviction to a
compressed tile store behind a tile store interface, pen/finger/mouse input, and canvas
inheritance (one read-only inherited block per canvas, chains, arrows, empty and missing-source
states).

Nothing is saved yet. Read the existing code and README first, and keep everything working.

Phase 4 makes work safe and recoverable. The gate for this phase is: **force-closing Safari
mid-session on my iPad loses at most the last stroke.**

## Start with a plan
Before coding, propose a plan covering the on-disk layout, tile hashing and compression, the
crash-safe write sequence, the save worker and GPU readback, version and retention rules,
garbage collection, and the export format. Wait for my approval.

## Architecture requirements

1. **Content-hashed tile store in OPFS**
   - Replace the backing of the existing tile store interface with OPFS. Each tile is stored
     once, keyed by a hash of its contents (at least 128 bits; propose SHA-256 via
     `crypto.subtle` or a fast non-cryptographic hash, with reasoning). Identical tiles across
     layers, canvases and versions are stored once. Empty tiles are never stored.
   - Store raw premultiplied RGBA, losslessly compressed (reuse the Phase 2 compression).
     **Don't encode tiles as PNG/WebP through a canvas**: that converts to non-premultiplied
     alpha and loses precision in semi-transparent pixels. A saved and reloaded tile must be
     byte-identical.
   - All disk I/O runs in a Web Worker (use OPFS sync access handles there where supported).
   - Evicted tiles from Phase 2 should now go to this store rather than staying compressed in
     memory, so memory use stays flat on large projects.

2. **Manifests**
   - A manifest describes the whole project: canvases (name, size, position, z-order), layers
     (settings and tile key → hash maps), inherited blocks (source state, placement, crop,
     effects, opacity, blend, visibility), and a `formatVersion`.
   - Versions are **project-level**, never per canvas, because inheritance makes canvases depend
     on each other.
   - Also save each canvas's small preview images, so a project opens and shows the whole
     workspace instantly while full tiles load.

3. **Crash-safe writes**
   - Order: write all new tiles → write the new manifest under a new name → atomically update a
     small "head" record pointing to it (for example in one IndexedDB transaction) → only then
     clean up anything old. Propose the exact mechanism.
   - If the app dies at any point, the head must point to a complete, consistent project.

4. **Working copy (continuous autosave)**
   - After a stroke ends, debounce (about 1–2 s, configurable), then read back only the dirty
     tiles from the GPU (asynchronously: `mapAsync` in WebGPU, pixel-buffer + fence in WebGL2),
     hash, compress and write them, then update the working-copy manifest.
   - Also save immediately on `visibilitychange` (hidden) and `pagehide`. Don't rely on
     `beforeunload` or `unload`; they often don't fire on iPad.
   - Non-stroke changes (layers, canvases, arrows, block settings) are saved the same way.
   - Saving must never cause dropped frames while drawing.

5. **Versions**
   - **Manual save:** creates a named version (default name: date and time) immediately.
   - **Automatic versions:** on launch, if the working copy differs from the latest version,
     turn it into an automatic version ("Session ended …"). Also create one after a configurable
     amount of active time (default 30 minutes) if anything changed.
   - Each version stores a thumbnail of the workspace.
   - **Restore** never deletes history: first save the current state as a version ("Before
     restore"), then load the chosen version as the new working copy. Clear the undo history on
     restore and tell the user.
   - **Retention:** keep all manual and pinned versions. For automatic versions, keep the last
     10, then one per day for 30 days, then one per week (all configurable). Users can pin,
     rename and delete versions.

6. **Garbage collection**
   - Mark and sweep: delete tiles not referenced by the working copy, any version, or the
     in-memory undo history. Run it when idle or at launch, in the worker, and make it
     interruptible. It must never delete a referenced tile.

7. **Projects**
   - Multiple projects with a project list: create, open, rename, duplicate, delete (with a
     confirmation step).
   - Use the Web Locks API so only one tab can edit a project at a time; a second tab opens it
     read-only with a notice.
   - Each project has its own folder in OPFS with its own tile store, manifests, versions and
     previews. Deleting a project removes its folder; duplicating copies its data. Garbage
     collection runs per project.
   - Inheritance arrows only connect canvases within the same project.
   - Undo history belongs to the open project: switching projects saves the current one and
     starts a fresh history.
   - The project list shows each project's size, plus total storage used against the browser's
     quota (shared by all projects).
   - Opening the app goes to the last opened project; the project list is one tap away.

8. **Storage safety**
   - Call `navigator.storage.persist()` and show the result in settings.
   - Show storage usage from `navigator.storage.estimate()` (project sizes and total).
   - Handle `QuotaExceededError` everywhere: keep the app usable, warn clearly, and offer
     to delete old automatic versions or export projects. Never leave a half-written save.
   - Detect when the app runs in a Safari tab instead of the installed home-screen app, and show
     a gentle notice: the two have separate storage, so install before starting real work, and
     use export/import to move projects between them.

9. **Format versioning**
   `formatVersion` in every manifest and export file, plus a migration registry (one function
   per version step) applied when loading older data. Include one test migration.

## Export and import
- **Project file:** a single file (zip container, for example using fflate) with manifests,
  tiles and previews, with an option to include or exclude version history. Use a placeholder
  extension for now; I'll choose the final name later.
- **Import:** validate, migrate, and import as a new project (new IDs; never overwrite an
  existing project).
- **PNG export per canvas:** flatten at full resolution, resolving inherited content through
  the whole chain. Converting to non-premultiplied alpha is fine here since it's a final image.
- **Delivery:** on iPad use the Web Share API with files when available, otherwise a download.
  On Chromium desktop, optionally use the File System Access API to save to a chosen location.

## Interface (functional; final design comes from my Figma files in Phase 5)
- Project list (with storage use per project).
- Save button and keyboard shortcut for manual versions.
- Version history panel: thumbnails, names, timestamps, manual vs. automatic, pin, rename,
  delete, restore.
- A small save status indicator (saved / saving / error).
- Settings: storage usage, persistence status, retention options, export/import.

## HUD and stress mode
- HUD: save queue length, last save duration, bytes written per save, total storage used,
  GC duration.
- Stress mode: generate a project with N canvases and M versions of scripted edits; measure
  storage per version, save time, project open time (to previews and to full resolution) and GC
  time; log to the JSON export.

## Out of scope
Cloud sync and accounts, collaboration, branching or comparing versions, PSD/PDF export, final
UI design.

## Testing
- Unit/integration tests: byte-identical tile round trips (including semi-transparent pixels),
  deduplication across layers and versions, crash safety (simulate the app dying between every
  step of the write sequence and confirm the head points to a valid project), working-copy
  autosave triggers, automatic version creation on launch, restore preserving history,
  retention rules, GC never deleting referenced tiles (including undo-history tiles), Web Locks
  behavior, migration, export/import round trips with and without history, and quota-exceeded
  handling.
- You can't test on my iPad, so don't claim device results. Give me an on-device checklist:
  the force-close gate (swipe Safari away mid-stroke and right after a stroke, then reopen);
  backgrounding the app and returning; low-power mode; a large project's open time; restoring
  an old version; export, delete, and re-import a project; sharing an exported PNG; Safari tab
  vs. installed app (including the notice); two tabs with the same project.

## Deliverables
1. The plan (before coding), then the features above.
2. Updated README: saving model, versions and retention, export/import, storage notes for iPad,
   stress mode options.
3. The on-device checklist.
4. A short findings note: storage per version, save and load times on desktop, known issues,
   and concerns about the Phase 4 gate.

## How to work
- Commit in small, working steps with clear messages.
- Ask me before changing anything under "Architecture requirements."
- Prefer simple, readable code; thesis examiners will read it.
