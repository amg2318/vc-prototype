import type { TileId } from '../document/tiles';
import { deflate, inflate } from '../storage/compression';

export { deflate, inflate };

/**
 * Where evicted tile pixels go. Tiles are immutable, so a tile id always
 * names the same pixels.
 *
 * Phase 2 kept them compressed in JS memory (`CompressedTileStore`, still the
 * fallback); Phase 4 keeps them in the content-hashed project store in OPFS
 * (`DiskTileBackingStore`), written by the storage worker.
 */
export interface TileBackingStore {
  /** Store a tile's raw RGBA pixels (TILE_SIZE² × 4 bytes). Resolves once stored. */
  put(id: TileId, rgba: Uint8Array): Promise<void>;
  /** The tile's raw RGBA pixels. Rejects if the tile isn't stored. */
  get(id: TileId): Promise<Uint8Array>;
  has(id: TileId): boolean;
  /** Forget a tile (it was reloaded onto the GPU, or nothing uses it any more). */
  evict(id: TileId): void;
  /** Tiles stored in memory and the bytes they take. */
  stats(): { tiles: number; bytes: number };
  /**
   * Phase 4: true if the tile's pixels are already kept outside the GPU (on
   * disk) and stay there, so evicting it needs no readback.
   */
  isPersisted?(id: TileId): boolean;
}

/**
 * Evicted tiles, deflate-compressed in JS memory. Painted tiles are mostly
 * flat colour or transparency, so they usually compress very well; the HUD
 * shows the real ratio.
 *
 * `put` and `get` may overlap: a `get` while the tile is still being
 * compressed waits for it.
 */
export class CompressedTileStore implements TileBackingStore {
  private readonly tiles = new Map<TileId, Uint8Array>();
  private readonly pending = new Map<TileId, Promise<void>>();
  private bytes = 0;

  put(id: TileId, rgba: Uint8Array): Promise<void> {
    this.evict(id);
    const done = deflate(rgba).then((compressed) => {
      if (this.pending.get(id) !== done) return; // evicted (or replaced) meanwhile
      this.pending.delete(id);
      this.tiles.set(id, compressed);
      this.bytes += compressed.byteLength;
    });
    this.pending.set(id, done);
    return done;
  }

  async get(id: TileId): Promise<Uint8Array> {
    await this.pending.get(id);
    const compressed = this.tiles.get(id);
    if (!compressed) throw new Error(`tile ${id} is not stored`);
    return inflate(compressed);
  }

  has(id: TileId): boolean {
    return this.tiles.has(id) || this.pending.has(id);
  }

  evict(id: TileId): void {
    this.pending.delete(id);
    const compressed = this.tiles.get(id);
    if (!compressed) return;
    this.bytes -= compressed.byteLength;
    this.tiles.delete(id);
  }

  stats(): { tiles: number; bytes: number } {
    return { tiles: this.tiles.size, bytes: this.bytes };
  }
}
