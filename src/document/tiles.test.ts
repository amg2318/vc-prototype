import { describe, expect, it } from 'vitest';
import { CANVAS_WIDTH, PAGE_SIDE_TILES, SLOTS_PER_PAGE, TILES_X, TILES_Y, TILE_SIZE } from '../config';
import { DirtyTiles, slotLocation, tileAt, tileCoords, tileKey, tileOrigin, tilesInRect } from './tiles';

describe('tile coordinates', () => {
  it('round-trips keys and coordinates', () => {
    for (const [tx, ty] of [[0, 0], [3, 7], [TILES_X - 1, TILES_Y - 1]] as const) {
      expect(tileCoords(tileKey(tx, ty))).toEqual({ tx, ty });
    }
  });

  it('gives the tile origin in pixels', () => {
    expect(tileOrigin(tileKey(2, 5))).toEqual({ x: 2 * TILE_SIZE, y: 5 * TILE_SIZE });
  });

  it('finds the tile under a pixel and rejects pixels outside the canvas', () => {
    expect(tileAt(0, 0)).toBe(0);
    expect(tileAt(TILE_SIZE - 0.5, TILE_SIZE)).toBe(tileKey(0, 1));
    expect(tileAt(-1, 10)).toBeNull();
    expect(tileAt(CANVAS_WIDTH, 10)).toBeNull();
  });
});

describe('tilesInRect', () => {
  it('returns one tile for a rect inside it', () => {
    expect(tilesInRect(10, 10, 20, 20)).toEqual([0]);
  });

  it('treats the right/bottom edge as exclusive', () => {
    expect(tilesInRect(0, 0, TILE_SIZE, TILE_SIZE)).toEqual([0]);
    expect(tilesInRect(0, 0, TILE_SIZE + 1, TILE_SIZE)).toEqual([0, 1]);
  });

  it('spans a 2×2 block across a tile corner', () => {
    const c = TILE_SIZE;
    expect(tilesInRect(c - 5, c - 5, c + 5, c + 5).sort((a, b) => a - b)).toEqual(
      [tileKey(0, 0), tileKey(1, 0), tileKey(0, 1), tileKey(1, 1)].sort((a, b) => a - b),
    );
  });

  it('clips to the canvas', () => {
    expect(tilesInRect(-500, -500, 5, 5)).toEqual([0]);
    expect(tilesInRect(-10, -10, -1, -1)).toEqual([]);
  });
});

describe('slotLocation', () => {
  it('lays slots out row by row within a page, then moves to the next page', () => {
    expect(slotLocation(0)).toEqual({ page: 0, x: 0, y: 0 });
    expect(slotLocation(1)).toEqual({ page: 0, x: TILE_SIZE, y: 0 });
    expect(slotLocation(PAGE_SIDE_TILES)).toEqual({ page: 0, x: 0, y: TILE_SIZE });
    expect(slotLocation(SLOTS_PER_PAGE + 1)).toEqual({ page: 1, x: TILE_SIZE, y: 0 });
  });
});

describe('DirtyTiles', () => {
  it('adds the tiles a dab covers, including its anti-aliased edge', () => {
    const dirty = new DirtyTiles();
    dirty.addDab({ x: TILE_SIZE - 2, y: 50, radius: 2 }); // edge reaches past x = TILE_SIZE
    expect([...dirty.keys].sort()).toEqual([0, 1]);
  });

  it('deduplicates across many dabs', () => {
    const dirty = new DirtyTiles();
    dirty.addDabs(Array.from({ length: 100 }, (_, i) => ({ x: 10 + i, y: 10, radius: 4 })));
    expect(dirty.size).toBe(1);
  });

  it('a long horizontal stroke dirties one row of tiles', () => {
    const dirty = new DirtyTiles();
    for (let x = 5; x < CANVAS_WIDTH - 5; x += 3) dirty.addDab({ x, y: 100, radius: 3 });
    expect(dirty.size).toBe(TILES_X);
  });
});
