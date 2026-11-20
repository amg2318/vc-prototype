import { MAX_TILE_IDS, SLOTS_PER_PAGE } from '../config';

/**
 * A pool of reference-counted numbers. Used for tile ids (what documents and
 * undo history hold) and for GPU slot pools.
 *
 * Tiles are immutable once written. A stroke never paints into an existing
 * tile; it writes `old tile + stroke` into a freshly allocated tile. That lets
 * layers, duplicated layers and undo history share tiles safely: each holder
 * takes a reference, and a tile is freed when the last reference is released
 * (`onFree` listeners then drop its pixels, on the GPU or compressed).
 *
 * Each allocation also bumps the number's generation, so asynchronous GPU
 * results (e.g. "this tile turned out empty") can be checked against the
 * allocation they were about.
 *
 * Freed numbers are reused first; otherwise numbers are handed out in order,
 * so GPU slot pools fill their pages one at a time.
 */
export class TileStore {
  private readonly refCounts: Uint16Array;
  private readonly generations: Uint32Array;
  private readonly free: number[] = [];
  private nextFresh = 0;
  private used = 0;
  private readonly freeListeners: ((n: number) => void)[] = [];

  constructor(readonly capacity: number = MAX_TILE_IDS) {
    this.refCounts = new Uint16Array(capacity);
    this.generations = new Uint32Array(capacity);
  }

  /** Allocate a number with one reference, or null if the pool is full. */
  allocate(): number | null {
    const n = this.free.pop() ?? (this.nextFresh < this.capacity ? this.nextFresh++ : null);
    if (n === null) return null;
    this.refCounts[n] = 1;
    this.generations[n]!++;
    this.used++;
    return n;
  }

  retain(n: number): void {
    if (this.refCounts[n] === 0) throw new Error(`retain of free tile ${n}`);
    this.refCounts[n]!++;
  }

  release(n: number): void {
    const count = this.refCounts[n]!;
    if (count === 0) throw new Error(`release of free tile ${n}`);
    this.refCounts[n] = count - 1;
    if (count === 1) {
      this.used--;
      this.free.push(n);
      for (const listener of this.freeListeners) listener(n);
    }
  }

  /** Called with each number whose last reference was released. */
  onFree(listener: (n: number) => void): void {
    this.freeListeners.push(listener);
  }

  refCount(n: number): number {
    return this.refCounts[n]!;
  }

  generation(n: number): number {
    return this.generations[n]!;
  }

  get usedSlots(): number {
    return this.used;
  }

  get freeSlots(): number {
    return this.capacity - this.used;
  }

  /** Atlas pages needed to back every number handed out so far (for GPU slot pools). */
  get pagesNeeded(): number {
    return Math.ceil(this.nextFresh / SLOTS_PER_PAGE);
  }
}
