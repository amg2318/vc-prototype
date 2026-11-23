import { TILE_BYTES } from '../config';
import type { TileId } from '../document/tiles';
import type { TileStore } from '../document/tileStore';
import type { StorageClient } from '../storage/client';
import { CompressedTileStore, type TileBackingStore } from '../render/tileBackingStore';
import type { TileHashes } from './tileHashes';

/**
 * Where evicted layer tiles go in Phase 4: the open project's content-hashed
 * store on disk, written by the storage worker. JS memory then holds no tile
 * pixels at all, so memory stays flat however large the project is.
 *
 * Saving and eviction share the work: a tile is hashed and written once,
 * whichever needs it first. A tile already on disk (`isPersisted`) leaves
 * the GPU without a readback, and an evicted tile needs no further work to
 * be saved.
 *
 * If a write fails (storage full or unavailable), the tile is kept
 * compressed in memory instead, as in Phase 2, so nothing is lost.
 */
export class DiskTileBackingStore implements TileBackingStore {
  /** Writes in flight, by tile id. */
  private readonly writing = new Map<TileId, Promise<void>>();
  /** Tiles that couldn't be written to disk. */
  private readonly fallback = new CompressedTileStore();
  /**
   * False in a read-only tab: evicted tiles stay compressed in memory, since
   * the tab that owns the project may garbage-collect anything it doesn't use.
   */
  writeToDisk = true;
  /** Called when a write fails (e.g. storage full). */
  onWriteError: ((error: unknown) => void) | null = null;

  constructor(
    private readonly storage: StorageClient,
    private readonly hashes: TileHashes,
    private readonly store: TileStore,
  ) {}

  isPersisted(id: TileId): boolean {
    return this.hashes.has(id) && !this.writing.has(id);
  }

  put(id: TileId, rgba: Uint8Array): Promise<void> {
    if (this.hashes.has(id)) return Promise.resolve(); // already on disk
    if (!this.writeToDisk) return this.fallback.put(id, rgba);
    const generation = this.store.generation(id);
    const done = this.storage
      .putTiles([rgba])
      .then(([result]) => {
        if (this.store.generation(id) === generation) this.hashes.set(id, result?.hash ?? null);
      })
      .catch((error: unknown) => {
        this.onWriteError?.(error);
        return this.fallback.put(id, rgba);
      })
      .finally(() => {
        if (this.writing.get(id) === done) this.writing.delete(id);
      });
    this.writing.set(id, done);
    return done;
  }

  async get(id: TileId): Promise<Uint8Array> {
    await this.writing.get(id);
    if (this.fallback.has(id)) return this.fallback.get(id);
    const hash = this.hashes.get(id);
    if (hash === null) return new Uint8Array(TILE_BYTES); // empty
    if (hash === undefined) throw new Error(`tile ${id} is not stored`);
    return this.storage.getTile(hash);
  }

  has(id: TileId): boolean {
    return this.hashes.has(id) || this.writing.has(id) || this.fallback.has(id);
  }

  /** The tile is back on the GPU or no longer used. The copy on disk stays (garbage collection removes it). */
  evict(id: TileId): void {
    this.fallback.evict(id);
  }

  /** Tiles held in JS memory: only those that couldn't be written to disk. */
  stats(): { tiles: number; bytes: number } {
    return this.fallback.stats();
  }
}
