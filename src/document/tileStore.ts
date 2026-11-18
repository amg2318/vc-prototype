import { MAX_TILE_SLOTS, SLOTS_PER_PAGE } from '../config';
import type { TileSlot } from './tiles';

/**
 * CPU-side bookkeeping for the GPU tile pool: which slots are in use, and how
 * many references each has.
 *
 * Tiles are immutable once written. A stroke never paints into an existing
 * tile; it writes `old tile + stroke` into a freshly allocated slot. That lets
 * layers, duplicated layers and undo history share slots safely: each holder
 * takes a reference, and a slot returns to the free list when the last
 * reference is released.
 *
 * Each allocation also bumps the slot's generation, so asynchronous GPU
 * results (e.g. "this tile turned out empty") can be checked against the
 * allocation they were about.
 */
export class TileStore {
  private readonly refCounts: Uint16Array;
  private readonly generations: Uint32Array;
  private used = 0;
  private highestPage = -1;

  constructor(readonly capacity: number = MAX_TILE_SLOTS) {
    this.refCounts = new Uint16Array(capacity);
    this.generations = new Uint32Array(capacity);
  }

  /** Allocate a slot with one reference, or null if the pool is full. Prefers low slots so pages fill in order. */
  allocate(): TileSlot | null {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.refCounts[slot] === 0) {
        this.refCounts[slot] = 1;
        this.generations[slot]!++;
        this.used++;
        this.highestPage = Math.max(this.highestPage, Math.floor(slot / SLOTS_PER_PAGE));
        return slot;
      }
    }
    return null;
  }

  retain(slot: TileSlot): void {
    if (this.refCounts[slot] === 0) throw new Error(`retain of free tile slot ${slot}`);
    this.refCounts[slot]!++;
  }

  release(slot: TileSlot): void {
    const count = this.refCounts[slot]!;
    if (count === 0) throw new Error(`release of free tile slot ${slot}`);
    this.refCounts[slot] = count - 1;
    if (count === 1) this.used--;
  }

  refCount(slot: TileSlot): number {
    return this.refCounts[slot]!;
  }

  generation(slot: TileSlot): number {
    return this.generations[slot]!;
  }

  get usedSlots(): number {
    return this.used;
  }

  get freeSlots(): number {
    return this.capacity - this.used;
  }

  /** Number of atlas pages the GPU needs to back every slot allocated so far. */
  get pagesNeeded(): number {
    return this.highestPage + 1;
  }
}
