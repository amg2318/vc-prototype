import { MAX_LOADS_IN_FLIGHT } from '../config';
import { TileStore } from '../document/tileStore';
import type { TileId, TileSlot } from '../document/tiles';
import type { TileBackingStore } from './tileBackingStore';

/**
 * Which tiles are on the GPU. Documents and undo history hold tile ids; the
 * GPU only has room for `capacity` of them (the layer memory budget). When a
 * new tile needs a slot and none is free, the least recently used tile is
 * evicted: its pixels are read back and handed to the backing store
 * (compressed). Reading an evicted tile starts reloading it; until it is back,
 * whatever needs it waits (the canvas shows its preview meanwhile).
 *
 * This class is bookkeeping only. The renderer turns its answers into GPU
 * work in order: an eviction's readback always runs before anything writes
 * into the freed slot.
 *
 * A tile used in the current frame is never evicted in that frame, so
 * everything a frame reads stays where the frame expects it.
 */

/** A tile leaving the GPU: read `slot` back and pass its pixels to `pixels`. */
export interface Eviction {
  id: TileId;
  slot: TileSlot;
  pixels(rgba: Uint8Array): void;
}

export interface SlotPlacement {
  slot: TileSlot;
  /** A tile evicted to make room; read it back before writing to `slot`. */
  evicted: Eviction | null;
}

/** A reloaded tile to upload. */
export interface Upload extends SlotPlacement {
  id: TileId;
  rgba: Uint8Array;
}

type Entry =
  | { where: 'gpu'; slot: TileSlot; lastUsed: number }
  /** Off the GPU. `stored` resolves once the backing store has it. */
  | { where: 'stored'; stored: Promise<void> }
  | { where: 'loading'; requestedAt: number }
  | { where: 'loaded'; requestedAt: number; rgba: Uint8Array };

export interface ResidencyStats {
  capacity: number;
  resident: number;
  /** Evicted tiles (stored or on their way back). */
  offGpu: number;
  loading: number;
  /** Totals since start. */
  evictions: number;
  reloads: number;
}

export class TileResidency {
  /** GPU slot pool (its `pagesNeeded` tells the renderer how many pages to create). */
  readonly slots: TileStore;
  private readonly entries = new Map<TileId, Entry>();
  /** Tiles on the GPU, least recently used first. */
  private readonly lru = new Map<TileId, Extract<Entry, { where: 'gpu' }>>();
  private readonly loadedQueue: TileId[] = [];
  private loadsInFlight = 0;
  private frame = 0;
  private evictions = 0;
  private reloads = 0;
  private reloadTimes: number[] = [];

  constructor(
    readonly capacity: number,
    private readonly backing: TileBackingStore,
    private readonly now: () => number = () => performance.now(),
    private readonly maxLoadsInFlight = MAX_LOADS_IN_FLIGHT,
  ) {
    this.slots = new TileStore(capacity);
  }

  beginFrame(): void {
    this.frame++;
  }

  slotOf(id: TileId): TileSlot | undefined {
    const e = this.entries.get(id);
    return e?.where === 'gpu' ? e.slot : undefined;
  }

  isResident(id: TileId): boolean {
    return this.entries.get(id)?.where === 'gpu';
  }

  /**
   * True if every tile is on the GPU; they are then kept there for this
   * frame. Tiles that aren't start reloading. Unknown ids (never written)
   * count as present: they read as transparent.
   */
  ensure(ids: Iterable<TileId>): boolean {
    let ready = true;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.where === 'gpu') this.touch(id, e);
      else {
        ready = false;
        if (e.where === 'stored') this.startLoad(id, e);
      }
    }
    return ready;
  }

  /**
   * A slot to write tile `id` into (its current slot if it is already on the
   * GPU), evicting the least recently used tile if the pool is full. Null if
   * every slot holds a tile used this frame.
   */
  place(id: TileId): SlotPlacement | null {
    const e = this.entries.get(id);
    if (e?.where === 'gpu') {
      this.touch(id, e);
      return { slot: e.slot, evicted: null };
    }
    let evicted: Eviction | null = null;
    let slot = this.slots.allocate();
    if (slot === null) {
      evicted = this.evictOne();
      if (!evicted) return null;
      slot = this.slots.allocate()!;
    }
    if (e) this.backing.evict(id); // a stale copy (tiles are immutable, so this is rare)
    const entry = { where: 'gpu' as const, slot, lastUsed: this.frame };
    this.entries.set(id, entry);
    this.lru.set(id, entry);
    return { slot, evicted };
  }

  /** Reloaded tiles to upload this frame, each placed in a slot (in order). */
  takeUploads(limit: number): Upload[] {
    const uploads: Upload[] = [];
    while (uploads.length < limit && this.loadedQueue.length > 0) {
      const id = this.loadedQueue[0]!;
      const e = this.entries.get(id);
      if (e?.where !== 'loaded') {
        this.loadedQueue.shift(); // freed meanwhile
        continue;
      }
      this.entries.delete(id); // so place() allocates a fresh slot
      const placed = this.place(id);
      if (!placed) {
        this.entries.set(id, e); // no room this frame
        break;
      }
      this.loadedQueue.shift();
      this.backing.evict(id); // each tile lives in exactly one place
      this.reloads++;
      this.reloadTimes.push(this.now() - e.requestedAt);
      uploads.push({ id, rgba: e.rgba, ...placed });
    }
    return uploads;
  }

  /** Nothing refers to the tile any more: drop it wherever it is. */
  free(id: TileId): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.where === 'gpu') {
      this.lru.delete(id);
      this.slots.release(e.slot);
    }
    this.backing.evict(id);
  }

  stats(): ResidencyStats {
    let offGpu = 0;
    let loading = 0;
    for (const e of this.entries.values()) {
      if (e.where !== 'gpu') offGpu++;
      if (e.where === 'loading' || e.where === 'loaded') loading++;
    }
    return { capacity: this.capacity, resident: this.lru.size, offGpu, loading, evictions: this.evictions, reloads: this.reloads };
  }

  /** Reload latencies (ms, request → upload) since the last call. */
  takeReloadTimes(): number[] {
    const times = this.reloadTimes;
    this.reloadTimes = [];
    return times;
  }

  private touch(id: TileId, e: Extract<Entry, { where: 'gpu' }>): void {
    e.lastUsed = this.frame;
    this.lru.delete(id); // move to the most recently used end
    this.lru.set(id, e);
  }

  private evictOne(): Eviction | null {
    const first = this.lru.entries().next();
    if (first.done) return null;
    const [id, victim] = first.value;
    if (victim.lastUsed === this.frame) return null; // everything on the GPU is in use this frame
    this.lru.delete(id);
    this.slots.release(victim.slot);
    this.evictions++;
    let pixels!: (rgba: Uint8Array) => void;
    const entry: Entry = {
      where: 'stored',
      stored: new Promise<void>((resolve) => {
        pixels = (rgba) => {
          if (this.entries.get(id) !== entry) return resolve(); // freed before its pixels arrived
          void this.backing.put(id, rgba).then(resolve);
        };
      }),
    };
    this.entries.set(id, entry);
    return { id, slot: victim.slot, pixels };
  }

  private startLoad(id: TileId, e: Extract<Entry, { where: 'stored' }>): void {
    if (this.loadsInFlight >= this.maxLoadsInFlight) return;
    this.loadsInFlight++;
    const loading: Entry = { where: 'loading', requestedAt: this.now() };
    this.entries.set(id, loading);
    void e.stored
      .then(() => this.backing.get(id))
      .then(
        (rgba) => {
          if (this.entries.get(id) !== loading) return; // freed meanwhile
          this.entries.set(id, { where: 'loaded', requestedAt: loading.requestedAt, rgba });
          this.loadedQueue.push(id);
        },
        (error: unknown) => {
          console.error(`Could not reload tile ${id}:`, error);
          if (this.entries.get(id) === loading) this.entries.set(id, e); // try again later
        },
      )
      .finally(() => this.loadsInFlight--);
  }
}
