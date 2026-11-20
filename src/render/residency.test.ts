import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileResidency } from './residency';
import { CompressedTileStore } from './tileBackingStore';

const pixels = (value: number): Uint8Array => new Uint8Array(TILE_BYTES).fill(value);
/** Let promise callbacks (compression, decompression) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function setup(capacity = 2) {
  const backing = new CompressedTileStore();
  return { backing, r: new TileResidency(capacity, backing, () => 0) };
}

describe('TileResidency', () => {
  it('places new tiles in free slots, then evicts the least recently used', () => {
    const { r } = setup(2);
    r.beginFrame();
    expect(r.place(1)).toEqual({ slot: 0, evicted: null });
    expect(r.place(2)).toEqual({ slot: 1, evicted: null });
    r.beginFrame();
    r.ensure([1]); // 1 is used again, so 2 is now the oldest
    const third = r.place(3)!;
    expect(third.slot).toBe(1);
    expect(third.evicted).toMatchObject({ id: 2, slot: 1 });
    expect(r.isResident(2)).toBe(false);
    expect(r.stats()).toMatchObject({ resident: 2, offGpu: 1, evictions: 1 });
  });

  it('never evicts a tile used in the current frame', () => {
    const { r } = setup(2);
    r.beginFrame();
    r.place(1);
    r.place(2);
    expect(r.place(3)).toBeNull();
    r.beginFrame();
    r.ensure([1, 2]);
    expect(r.place(3)).toBeNull();
  });

  it('reloads an evicted tile with the same pixels', async () => {
    const { r, backing } = setup(1);
    r.beginFrame();
    r.place(1);
    r.beginFrame();
    r.place(2)!.evicted!.pixels(pixels(7)); // the renderer reads tile 1 back
    await settle();
    expect(backing.has(1)).toBe(true);

    r.beginFrame();
    expect(r.ensure([1])).toBe(false); // starts the reload
    await settle();
    r.beginFrame();
    const [upload] = r.takeUploads(8);
    expect(upload).toMatchObject({ id: 1, slot: 0 });
    expect(upload!.rgba).toEqual(pixels(7));
    expect(upload!.evicted?.id).toBe(2); // tile 2 made room
    expect(r.ensure([1])).toBe(true);
    expect(backing.has(1)).toBe(false); // each tile lives in one place
    expect(r.stats().reloads).toBe(1);
  });

  it('can reload a tile whose compression has not finished yet', async () => {
    const { r } = setup(1);
    r.beginFrame();
    r.place(1);
    r.beginFrame();
    r.place(2)!.evicted!.pixels(pixels(3));
    r.ensure([1]); // straight away
    await settle();
    r.beginFrame();
    expect(r.takeUploads(8)[0]?.rgba).toEqual(pixels(3));
  });

  it('can reload a tile asked for before its pixels were read back', async () => {
    const { r } = setup(1);
    r.beginFrame();
    r.place(1);
    r.beginFrame();
    const eviction = r.place(2)!.evicted!;
    r.beginFrame();
    r.ensure([1]); // the GPU readback hasn't finished yet
    eviction.pixels(pixels(5));
    await settle();
    r.beginFrame();
    expect(r.takeUploads(8)[0]?.rgba).toEqual(pixels(5));
  });

  it('forgets freed tiles wherever they are', async () => {
    const { r, backing } = setup(1);
    r.beginFrame();
    r.place(1);
    r.beginFrame();
    const eviction = r.place(2)!.evicted!;
    eviction.pixels(pixels(1));
    await settle();
    r.free(1);
    expect(backing.has(1)).toBe(false);
    r.free(2);
    expect(r.slots.usedSlots).toBe(0);
    expect(r.stats()).toMatchObject({ resident: 0, offGpu: 0 });
  });

  it('drops a reload of a tile freed while loading', async () => {
    const { r } = setup(1);
    r.beginFrame();
    r.place(1);
    r.beginFrame();
    r.place(2)!.evicted!.pixels(pixels(1));
    r.ensure([1]);
    r.free(1);
    await settle();
    r.beginFrame();
    expect(r.takeUploads(8)).toEqual([]);
  });

  it('limits reloads in flight', async () => {
    const backing = new CompressedTileStore();
    const r = new TileResidency(1, backing, () => 0, 2);
    r.beginFrame();
    r.place(0);
    for (let id = 1; id <= 4; id++) {
      r.beginFrame();
      r.place(id)!.evicted!.pixels(pixels(id));
    }
    await settle();
    r.beginFrame();
    r.ensure([0, 1, 2, 3]);
    expect(r.stats().loading).toBe(2);
  });

  it('treats ids it has never seen as present (they read as transparent)', () => {
    const { r } = setup(1);
    expect(r.ensure([42])).toBe(true);
    expect(r.slotOf(42)).toBeUndefined();
  });
});
