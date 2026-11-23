import type { CanvasId } from '../document/paintDocument';
import { tileCoords, type TileId } from '../document/tiles';
import type { PreviewTile } from '../render/renderer';
import { tileMapKey, type CanvasRecord, type PreviewRecord, type RootManifest } from '../storage/format';
import type { CanvasEntry } from '../storage/projectStore';
import type { CommitReply, HeadEdit } from '../storage/service';
import type { StorageClient } from '../storage/client';
import type { ObjectHash } from '../storage/objectCodec';
import type { Workspace } from '../workspace/workspace';
import { canvasRecord, unhashedTiles } from './snapshot';
import type { TileHashes } from './tileHashes';

/**
 * Saves the working copy: one call to `save` is one save.
 *
 *  0. Read back the previews (composite levels 3–4) of canvases whose
 *     composite changed, and store them like tiles. A preview that isn't up
 *     to date yet keeps its previous version and is tried at the next save.
 *  1. Find the layer tiles nothing has hashed yet, read them back from the
 *     GPU (asynchronously, a few per frame) and send them to the storage
 *     worker, which hashes, compresses and writes them.
 *  2. Build the record of every canvas and compare it with the last saved
 *     one: only changed records are sent; unchanged canvases are referred to
 *     by the hash of their saved record.
 *  3. Ask the worker to commit (records → manifest → head).
 *
 * Strokes may continue during a save. Step 1 repeats until every tile the
 * records need has a hash, then step 2 runs synchronously, so a save is a
 * consistent snapshot of one moment.
 */

export interface SaverDeps {
  workspace: Workspace;
  hashes: TileHashes;
  storage: StorageClient;
  readLayerTiles(ids: readonly TileId[]): Promise<(Uint8Array | null)[]>;
  /** The canvas's preview tiles (composite levels 3–4), or null if they aren't up to date yet. */
  readPreviewTiles(canvasId: CanvasId): Promise<PreviewTile[] | null>;
  view(): RootManifest['view'] | undefined;
  /** Head fields to update with every commit (the active editing time). */
  headExtras?(): HeadEdit;
}

export interface SaveStats {
  ms: number;
  bytesWritten: number;
  tilesWritten: number;
  recordsWritten: number;
  /** False if nothing had changed (no commit was made). */
  committed: boolean;
}

export interface SaveOptions {
  /** Head changes made in the same commit (e.g. a new version). */
  head?: (current: CommitReply['head'] | null) => HeadEdit;
  thumbnail?: { name: string; bytes: Uint8Array };
  /** Commit even if nothing changed (a manual version of an unchanged project). */
  force?: boolean;
  /** An urgent save (the page is being hidden): keep the previous previews, refresh them later. */
  skipPreviews?: boolean;
}

/** Hash rounds before giving up on a moving target (strokes keep adding tiles). */
const MAX_HASH_ROUNDS = 5;

export class ProjectSaver {
  /** The last saved record of each canvas, and its hash. */
  private saved = new Map<CanvasId, { record: CanvasRecord; hash: ObjectHash }>();
  private savedManifest: string | null = null;
  /** The camera of the last save. */
  private savedView: string | null = null;
  /** The current saved previews of each canvas. */
  private previews = new Map<CanvasId, PreviewRecord[]>();
  /** Canvases whose composite changed since their preview was saved. */
  readonly previewsDirty = new Set<CanvasId>();
  head: CommitReply['head'] | null = null;
  lastStats: SaveStats | null = null;

  constructor(private readonly deps: SaverDeps) {}

  /** After opening a project: what is on disk now, so the next save only writes changes. */
  remember(records: CanvasRecord[], hashes: ObjectHash[], manifest: RootManifest | null, head: CommitReply['head'] | null): void {
    this.saved = new Map(records.map((r, i) => [r.id, { record: r, hash: hashes[i]! }]));
    this.previews = new Map(records.map((r) => [r.id, r.previews]));
    this.previewsDirty.clear();
    this.savedManifest = manifest ? manifestKey(manifest.canvases.map((c) => c.id), manifest.canvasCounter) : null;
    this.savedView = JSON.stringify(manifest?.view ?? null);
    this.head = head;
  }

  async save(options: SaveOptions = {}): Promise<SaveStats> {
    const start = performance.now();
    const { workspace, hashes, storage } = this.deps;
    let tilesWritten = 0;
    let bytesWritten = 0;

    // 0. Previews of canvases whose composite changed.
    for (const doc of workspace.canvases) {
      if (options.skipPreviews || (!this.previewsDirty.has(doc.id) && this.previews.has(doc.id))) continue;
      const written = await this.savePreview(doc.id);
      tilesWritten += written.tiles;
      bytesWritten += written.bytes;
    }

    // 1. Hash every tile the canvases use (the target moves while strokes go on).
    for (let round = 0; ; round++) {
      const missing = [...unhashedTiles(workspace.canvases, hashes)];
      if (missing.length === 0) break;
      if (round === MAX_HASH_ROUNDS) throw new Error('Tiles kept changing while saving; will try again');
      const written = await this.hashTiles(missing);
      tilesWritten += written.tiles;
      bytesWritten += written.bytes;
    }

    // 2. Records (synchronous from here to the commit message: one consistent moment).
    const canvases: CanvasEntry[] = [];
    let recordsWritten = 0;
    for (const doc of workspace.canvases) {
      const record = canvasRecord(doc, hashes, this.previews.get(doc.id) ?? []);
      const previous = this.saved.get(doc.id);
      if (previous && recordsEqual(previous.record, record)) {
        canvases.push({ id: doc.id, hash: previous.hash });
      } else {
        canvases.push({ id: doc.id, record });
        recordsWritten++;
      }
    }
    const manifest = manifestKey(workspace.canvases.map((c) => c.id), workspace.canvasCounter);
    const unchanged = recordsWritten === 0 && manifest === this.savedManifest && !this.viewChanged();
    if (unchanged && !options.force && !options.head) {
      return (this.lastStats = { ms: performance.now() - start, bytesWritten, tilesWritten, recordsWritten, committed: false });
    }

    // 3. Commit.
    const view = this.deps.view();
    const reply = await storage.commit({
      canvases,
      canvasCounter: workspace.canvasCounter,
      activeCanvasId: workspace.activeCanvasId,
      ...(view ? { view } : {}),
      head: { ...this.deps.headExtras?.(), ...options.head?.(this.head) },
      ...(options.thumbnail ? { thumbnail: options.thumbnail } : {}),
    });
    const hashOf = new Map(reply.recordHashes);
    const next = new Map<CanvasId, { record: CanvasRecord; hash: ObjectHash }>();
    for (const entry of canvases) {
      const record = 'record' in entry ? entry.record : this.saved.get(entry.id)!.record;
      next.set(entry.id, { record, hash: hashOf.get(entry.id)! });
    }
    this.saved = next;
    this.savedManifest = manifest;
    this.savedView = JSON.stringify(view ?? null);
    this.head = reply.head;
    bytesWritten += reply.bytesWritten;
    return (this.lastStats = { ms: performance.now() - start, bytesWritten, tilesWritten, recordsWritten, committed: true });
  }

  /** The saved record of each canvas, in workspace order (what the working manifest holds after a save). */
  savedRecords(): CanvasRecord[] {
    return [...this.saved.values()].map((s) => s.record);
  }

  /** True if the camera moved since the last save (saved when the page is hidden, not on every pan). */
  viewChanged(): boolean {
    return JSON.stringify(this.deps.view() ?? null) !== this.savedView;
  }

  /** Store the canvas's current preview tiles, if they are up to date. */
  private async savePreview(canvasId: CanvasId): Promise<{ tiles: number; bytes: number }> {
    this.previewsDirty.delete(canvasId); // changes from now on mark it again
    const tiles = await this.deps.readPreviewTiles(canvasId);
    if (!tiles) {
      this.previewsDirty.add(canvasId);
      return { tiles: 0, bytes: 0 };
    }
    const results = await this.deps.storage.putTiles(tiles.map((t) => t.rgba));
    const levels = new Map<number, PreviewRecord>();
    let written = 0;
    let bytes = 0;
    tiles.forEach((t, i) => {
      const result = results[i];
      if (result && result.written > 0) {
        written++;
        bytes += result.written;
      }
      let level = levels.get(t.level);
      if (!level) levels.set(t.level, (level = { level: t.level, tiles: {} }));
      if (!result) return; // transparent: left out
      const { tx, ty } = tileCoords(t.key);
      level.tiles[tileMapKey(tx, ty)] = result.hash;
    });
    this.previews.set(canvasId, [...levels.values()]);
    return { tiles: written, bytes };
  }

  /** Read tiles back, have the worker store them, and note their hashes. */
  private async hashTiles(ids: TileId[]): Promise<{ tiles: number; bytes: number }> {
    const { hashes, storage, workspace } = this.deps;
    const generations = ids.map((id) => workspace.store.generation(id));
    const pixels = await this.deps.readLayerTiles(ids);
    const read = ids.flatMap((id, i) => (pixels[i] ? [{ id, generation: generations[i]!, rgba: pixels[i]! }] : []));
    if (read.length === 0) return { tiles: 0, bytes: 0 };
    const results = await storage.putTiles(read.map((r) => r.rgba));
    let tiles = 0;
    let bytes = 0;
    read.forEach((r, i) => {
      const result = results[i]!;
      // The id may have been freed and reused while this was in flight.
      if (workspace.store.generation(r.id) === r.generation) hashes.set(r.id, result?.hash ?? null);
      if (result && result.written > 0) {
        tiles++;
        bytes += result.written;
      }
    });
    return { tiles, bytes };
  }
}

function manifestKey(canvasIds: string[], counter: number): string {
  return `${canvasIds.join('\n')}\n${counter}`;
}

/** Deep equality of two records (plain JSON data). */
export function recordsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!recordsEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
