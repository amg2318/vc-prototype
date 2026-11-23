import type { TileId } from '../document/tiles';
import type { TileStore } from '../document/tileStore';
import type { ObjectHash } from '../storage/objectCodec';

/**
 * Which saved content each tile id has. Tile ids are immutable, so a tile is
 * hashed (and written) once, the first time a save or an eviction needs it;
 * after that its hash is simply looked up.
 *
 * `null` means the tile turned out to be fully transparent: it is left out
 * of saved tile maps.
 *
 * The reverse map lets loading share ids: the same content in several
 * layers, or a version restored while its tiles are still in memory, uses
 * one tile id (with one reference per user), just as in memory.
 */
export class TileHashes {
  private readonly byId = new Map<TileId, ObjectHash | null>();
  private readonly byHash = new Map<ObjectHash, TileId>();

  constructor(private readonly store: TileStore) {
    store.onFree((id) => this.forget(id));
  }

  /** The tile's hash, null if it is empty, undefined if it hasn't been hashed yet. */
  get(id: TileId): ObjectHash | null | undefined {
    return this.byId.get(id);
  }

  has(id: TileId): boolean {
    return this.byId.has(id);
  }

  set(id: TileId, hash: ObjectHash | null): void {
    if (this.store.refCount(id) === 0) return; // freed while it was being saved
    this.byId.set(id, hash);
    if (hash !== null && !this.byHash.has(hash)) this.byHash.set(hash, id);
  }

  /**
   * A tile id with the given content, with one reference for the caller:
   * the id already holding it, or a new one. `fresh` ids have no pixels in
   * memory yet: the renderer must load them from disk when needed.
   */
  adopt(hash: ObjectHash): { id: TileId; fresh: boolean } | null {
    const existing = this.byHash.get(hash);
    if (existing !== undefined) {
      this.store.retain(existing);
      return { id: existing, fresh: false };
    }
    const id = this.store.allocate();
    if (id === null) return null;
    this.byId.set(id, hash);
    this.byHash.set(hash, id);
    return { id, fresh: true };
  }

  /** Hashes of every tile id still in use (layers, undo history, deleted canvases undo can bring back). */
  liveHashes(): Set<ObjectHash> {
    const live = new Set<ObjectHash>();
    for (const [id, hash] of this.byId) if (hash !== null && this.store.refCount(id) > 0) live.add(hash);
    return live;
  }

  get size(): number {
    return this.byId.size;
  }

  private forget(id: TileId): void {
    const hash = this.byId.get(id);
    this.byId.delete(id);
    if (hash != null && this.byHash.get(hash) === id) this.byHash.delete(hash);
  }
}
