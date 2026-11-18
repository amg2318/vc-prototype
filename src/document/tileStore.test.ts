import { describe, expect, it } from 'vitest';
import { SLOTS_PER_PAGE } from '../config';
import { TileStore } from './tileStore';

describe('TileStore', () => {
  it('allocates distinct slots and counts them', () => {
    const store = new TileStore(4);
    const a = store.allocate();
    const b = store.allocate();
    expect(a).not.toBe(b);
    expect(store.usedSlots).toBe(2);
    expect(store.freeSlots).toBe(2);
  });

  it('frees a slot only when the last reference is released, then reuses it', () => {
    const store = new TileStore(2);
    const a = store.allocate()!;
    store.retain(a);
    store.release(a);
    expect(store.usedSlots).toBe(1);
    store.release(a);
    expect(store.usedSlots).toBe(0);
    expect(store.allocate()).toBe(a);
  });

  it('returns null when full', () => {
    const store = new TileStore(1);
    store.allocate();
    expect(store.allocate()).toBeNull();
  });

  it('bumps the generation on every allocation of a slot', () => {
    const store = new TileStore(1);
    const a = store.allocate()!;
    const g = store.generation(a);
    store.release(a);
    store.allocate();
    expect(store.generation(a)).toBe(g + 1);
  });

  it('reports pages needed from the highest slot used', () => {
    const store = new TileStore(SLOTS_PER_PAGE * 2);
    expect(store.pagesNeeded).toBe(0);
    for (let i = 0; i <= SLOTS_PER_PAGE; i++) store.allocate();
    expect(store.pagesNeeded).toBe(2);
  });

  it('throws on retain/release of a free slot', () => {
    const store = new TileStore(1);
    expect(() => store.release(0)).toThrow();
    expect(() => store.retain(0)).toThrow();
  });
});
