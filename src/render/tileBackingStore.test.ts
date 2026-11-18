import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { CompressedTileStore, deflate, inflate } from './tileBackingStore';

function paintedTile(seed: number): Uint8Array {
  const rgba = new Uint8Array(TILE_BYTES);
  // A soft diagonal stroke over transparency, like a typical painted tile.
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const d = Math.abs(x - y - seed);
      if (d > 20) continue;
      const a = Math.round(255 * (1 - d / 20));
      rgba.set([a >> 1, a >> 2, a, a], (y * 256 + x) * 4);
    }
  }
  return rgba;
}

describe('deflate / inflate', () => {
  it('round-trips exactly', async () => {
    const tile = paintedTile(3);
    const back = await inflate(await deflate(tile));
    expect(back).toEqual(tile);
  });

  it('compresses a transparent tile to almost nothing', async () => {
    expect((await deflate(new Uint8Array(TILE_BYTES))).byteLength).toBeLessThan(1024);
  });
});

describe('CompressedTileStore', () => {
  it('stores, returns and forgets tiles, counting compressed bytes', async () => {
    const store = new CompressedTileStore();
    await store.put(1, paintedTile(0));
    await store.put(2, paintedTile(40));
    expect(store.has(1)).toBe(true);
    expect(await store.get(2)).toEqual(paintedTile(40));
    const { tiles, bytes } = store.stats();
    expect(tiles).toBe(2);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(TILE_BYTES / 4);
    store.evict(1);
    expect(store.has(1)).toBe(false);
    expect(store.stats().tiles).toBe(1);
    await expect(store.get(1)).rejects.toThrow();
  });

  it('lets a get wait for a put that is still compressing', async () => {
    const store = new CompressedTileStore();
    void store.put(7, paintedTile(9));
    expect(store.has(7)).toBe(true);
    expect(await store.get(7)).toEqual(paintedTile(9));
  });

  it('drops a tile evicted while it was still compressing', async () => {
    const store = new CompressedTileStore();
    const put = store.put(7, paintedTile(9));
    store.evict(7);
    await put;
    expect(store.has(7)).toBe(false);
    expect(store.stats()).toEqual({ tiles: 0, bytes: 0 });
  });
});
