import { PAGE_SIDE_TILES, SLOTS_PER_PAGE, TILES_X, TILES_Y, TILE_SIZE } from '../config';

/**
 * Tile coordinate math.
 *
 * A tile key is a single integer `ty * TILES_X + tx`, used as the key of each
 * layer's sparse tile map. Integers are cheap Map keys and pack directly into
 * the GPU lookup table, which is indexed the same way.
 */

export type TileKey = number;
/** Index of a tile slot in the GPU tile pool (page * SLOTS_PER_PAGE + index in page). */
export type TileSlot = number;

export function tileKey(tx: number, ty: number): TileKey {
  return ty * TILES_X + tx;
}

export function tileCoords(key: TileKey): { tx: number; ty: number } {
  return { tx: key % TILES_X, ty: Math.floor(key / TILES_X) };
}

/** Top-left of the tile in canvas pixels. */
export function tileOrigin(key: TileKey): { x: number; y: number } {
  const { tx, ty } = tileCoords(key);
  return { x: tx * TILE_SIZE, y: ty * TILE_SIZE };
}

/** The tile containing canvas pixel (x, y), or null if outside the canvas. */
export function tileAt(x: number, y: number): TileKey | null {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) return null;
  return tileKey(tx, ty);
}

/**
 * Every tile overlapping the axis-aligned rectangle [x0, x1) × [y0, y1),
 * clipped to the canvas.
 */
export function tilesInRect(x0: number, y0: number, x1: number, y1: number): TileKey[] {
  const tx0 = Math.max(0, Math.floor(x0 / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor(y0 / TILE_SIZE));
  const tx1 = Math.min(TILES_X - 1, Math.floor((x1 - 1e-6) / TILE_SIZE));
  const ty1 = Math.min(TILES_Y - 1, Math.floor((y1 - 1e-6) / TILE_SIZE));
  const keys: TileKey[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) keys.push(tileKey(tx, ty));
  }
  return keys;
}

/** Where a slot lives in the pool: which page, and its top-left pixel in that page. */
export function slotLocation(slot: TileSlot): { page: number; x: number; y: number } {
  const page = Math.floor(slot / SLOTS_PER_PAGE);
  const index = slot % SLOTS_PER_PAGE;
  return {
    page,
    x: (index % PAGE_SIDE_TILES) * TILE_SIZE,
    y: Math.floor(index / PAGE_SIDE_TILES) * TILE_SIZE,
  };
}

/** Dab extent in canvas pixels: radius + 1 px for the anti-aliased edge (matches the dab shaders). */
export interface CircleLike {
  x: number;
  y: number;
  radius: number;
}

/**
 * Collects the tiles a stroke (or anything else) touches. Later phases use the
 * same sets for partial saving and live updates between canvases.
 */
export class DirtyTiles {
  readonly keys = new Set<TileKey>();

  addRect(x0: number, y0: number, x1: number, y1: number): void {
    for (const key of tilesInRect(x0, y0, x1, y1)) this.keys.add(key);
  }

  addDab(d: CircleLike): void {
    const r = d.radius + 1;
    this.addRect(d.x - r, d.y - r, d.x + r, d.y + r);
  }

  addDabs(dabs: readonly CircleLike[]): void {
    for (const d of dabs) this.addDab(d);
  }

  addAll(keys: Iterable<TileKey>): void {
    for (const k of keys) this.keys.add(k);
  }

  get size(): number {
    return this.keys.size;
  }

  clear(): void {
    this.keys.clear();
  }
}
