# Phase 4 plan (approved 2026-11-22)

The plan proposed before coding, with the decisions approved. The spec is in
[phase4-instructions.md](phase4-instructions.md). The README describes what was built.

## Decisions

| Topic | Decision |
| ----- | -------- |
| Hash | SHA-256 (`crypto.subtle`, in the worker) over raw premultiplied RGBA; full 256-bit hex as the file name |
| Compression | Phase 2 `deflate-raw` (`CompressionStream`), lossless |
| Tile file | 24-byte header (magic, format, codec, raw length, payload length, CRC32 of payload) + payload. A file counts as present only if it validates, so a torn write is rewritten, never trusted |
| Empty tiles | Never written; left out of tile maps |
| Manifest | Two levels: a small **root manifest** (canvases in z-order → content-hashed **canvas records**, counters, camera) and one record per canvas (layers with `"tx,ty" → hash` maps, block, paper, preview hashes) |
| Commit point | One IndexedDB `readwrite` transaction (`durability: 'strict'`) updating the head record `{ working, versions }`. OPFS `move()` is not relied on (Safari support unconfirmed) |
| Write order | tiles → records → root manifest (new name) → head → delete the old working manifest if no version uses it |
| Autosave trigger | Debounce (1.5 s) after the last change with no stroke in progress, **or** as soon as a stroke ends while an earlier one is unsaved; immediately on `visibilitychange` (hidden) and `pagehide` |
| Readback | New `layerTiles` readback, capped per frame; WebGPU `mapAsync`, WebGL2 pixel-pack buffer + fence (evictions move to the same path) |
| Eviction | To the OPFS store; a tile that already has a hash is dropped from the GPU without a readback. `CompressedTileStore` stays as the fallback when OPFS is unavailable or full |
| Previews | Composite pyramid levels 3–4 per canvas, saved as tiles in the same store and seeded into the renderer on open |
| Versions | A version points to a root manifest (usually the working one at that moment) plus a PNG workspace thumbnail. "Before restore" versions are automatic (retention applies) |
| Retention | Manual and pinned kept; automatic: newest 10, newest per day for 30 days, newest per ISO week after that |
| GC | Mark (head, working copy, versions, live tile ids from the main thread) and sweep in slices; every put during a GC, deduplication hits included, is protected |
| Locks | `navigator.locks` per project, `ifAvailable`; no lock → read-only with a notice |
| Migration | Registry of steps; `0 → 1` is a test migration from a hand-written draft format |
| Export | `.vcproj` (placeholder), a zip made with fflate (first runtime dependency), with or without history; import always creates a new project |

## Commit order

1. Tile codec and hash
2. Storage interfaces, in-memory fakes, manifest and record format
3. Commit sequence + crash-injection tests
4. Migrations
5. OPFS + IndexedDB backends and the storage worker
6. Workspace snapshot / restore
7. Async layer readback on both backends
8. Autosave scheduler
9. Evictions to OPFS
10. Previews
11. Versions and retention
12. Restore
13. GC
14. Projects and Web Locks
15. Storage settings, quota handling, Safari-tab notice
16. Export / import, PNG export
17. HUD and stress mode
18. README, checklist, findings
