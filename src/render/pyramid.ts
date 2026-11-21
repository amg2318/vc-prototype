import {
  COMPOSITES_PER_FRAME,
  COMPOSITE_LEVEL0_PAGES,
  COMPOSITE_PREVIEW_PAGES,
  PINNED_PREVIEW_LEVEL,
  SLOTS_PER_PAGE,
  TILE_SIZE,
} from '../config';
import type { Rgba } from './renderer';
import type { CanvasId } from '../document/paintDocument';
import { tileCoords, tileKey, type TileKey, type TileSlot } from '../document/tiles';
import { TileStore } from '../document/tileStore';
import { intersect, type Placement, type Rect } from '../workspace/coords';

/**
 * Plans the composite cache of every canvas. Pure bookkeeping, no GPU: each
 * frame it decides which composite tiles to (re)build and what to draw, and
 * both GPU backends just execute the plan.
 *
 * Each canvas's composite is a pyramid of 256² tiles. A level-ℓ tile covers
 * 256·2^ℓ canvas pixels, so level 0 is full resolution and level 4 covers a
 * whole 4096 px canvas in one tile. The display uses the level that matches
 * the zoom, so the screen needs roughly the same number of tiles at any zoom.
 *
 * - **Level 0** tiles are composited from the layer tiles.
 * - **Levels 1–4** are box-filtered *directly from level-0 tiles*: a changed
 *   level-0 tile updates its small region in every coarser tile that is
 *   cached. No neighbouring tiles are needed, and an update costs about the
 *   same at every level.
 * - Levels from PINNED_PREVIEW_LEVEL up are never evicted, so a canvas always
 *   has something to show. A tile that isn't ready is drawn from the nearest
 *   coarser cached tile, or as plain paper.
 * - A level-0 tile only needed to update a coarser one is composited into a
 *   per-frame scratch tile.
 *
 * Level-0 tiles and previews live in separate pools (separate textures), so a
 * downsample never reads and writes the same texture.
 */

export const PYRAMID_LEVELS = 5;

/** Canvas pixels covered by one tile at `level`. */
export function levelSpan(level: number): number {
  return TILE_SIZE * 2 ** level;
}

/** The level to display at a zoom given as canvas pixels per device pixel. */
export function levelForZoom(canvasPxPerDevicePx: number): number {
  if (!(canvasPxPerDevicePx > 1)) return 0;
  return Math.min(PYRAMID_LEVELS - 1, Math.round(Math.log2(canvasPxPerDevicePx)));
}

/** Keys of the `level` tiles that overlap `rect` (canvas pixels), clipped to the canvas. */
export function levelTilesInRect(size: { width: number; height: number }, rect: Rect, level: number): TileKey[] {
  const clipped = intersect(rect, { x: 0, y: 0, width: size.width, height: size.height });
  if (!clipped) return [];
  const span = levelSpan(level);
  const keys: TileKey[] = [];
  const y1 = Math.ceil((clipped.y + clipped.height) / span);
  const x1 = Math.ceil((clipped.x + clipped.width) / span);
  for (let ty = Math.floor(clipped.y / span); ty < y1; ty++) {
    for (let tx = Math.floor(clipped.x / span); tx < x1; tx++) keys.push(tileKey(tx, ty));
  }
  return keys;
}

/** Canvas-pixel rect of a tile at `level`. */
export function levelTileRect(level: number, key: TileKey): Rect {
  const { tx, ty } = tileCoords(key);
  const span = levelSpan(level);
  return { x: tx * span, y: ty * span, width: span, height: span };
}

/** The level-`level` tile containing level-0 tile `key0`. */
function ancestorKey(key0: TileKey, level: number): TileKey {
  const { tx, ty } = tileCoords(key0);
  return tileKey(tx >> level, ty >> level);
}

/** What the planner needs to know about a canvas. */
export interface PlannerCanvas {
  id: CanvasId;
  placement: Placement;
  /** Premultiplied paper colour (transparent when the paper is hidden). */
  paper: Rgba;
  /** True if no layer has a tile at this level-0 key, so the composite there is plain paper. */
  isPaperOnly(key: TileKey): boolean;
  /** False while a layer tile at this key isn't on the GPU yet; compositing it waits. */
  isReady(key: TileKey): boolean;
  /** Depth in the inheritance graph (0 if absent): sources get the per-frame budget before their inheritors. */
  depth?: number;
}

/** Composite level-0 tile `key` of a canvas into `dst` (a level-0 pool slot). */
export interface CompositeJob {
  canvasId: CanvasId;
  key: TileKey;
  dst: TileSlot;
}

/**
 * Box-filter level-0 tile `src` (or plain `paper` when src is null) into the
 * square region (x, y, size) of preview tile `dst` at `level`.
 */
export interface DownsampleJob {
  canvasId: CanvasId;
  /** The preview tile being written (its key at `level`). */
  key: TileKey;
  src: TileSlot | null;
  paper: Rgba;
  dst: TileSlot;
  level: number;
  x: number;
  y: number;
  size: number;
}

/**
 * Draw part of a composite tile (or plain paper) over `canvasRect` of a canvas.
 * `texels` is the source region in tile texels (0..256).
 */
export type DisplayQuad =
  | { canvasId: CanvasId; canvasRect: Rect; kind: 'tile'; pool: 'level0' | 'preview'; slot: TileSlot; texels: Rect }
  | { canvasId: CanvasId; canvasRect: Rect; kind: 'paper'; color: Rgba };

export interface FramePlan {
  composites: CompositeJob[];
  downsamples: DownsampleJob[];
  /** Back to front. */
  display: DisplayQuad[];
  /** True if work was left for the next frame because of the per-frame budget. */
  overBudget: boolean;
}

interface CachedTile {
  slot: TileSlot;
  lastUsed: number;
  /** Level-0 keys still to draw into this tile, or null once it is complete. */
  todo: TileKey[] | null;
}

class CanvasCache {
  readonly levels: Map<TileKey, CachedTile>[] = Array.from({ length: PYRAMID_LEVELS }, () => new Map());
  /** Level-0 keys whose content changed and hasn't reached the cached tiles yet. */
  readonly pending = new Set<TileKey>();
  /** The canvas's paper colour, for regions drawn as plain paper. */
  paper: Rgba = [1, 1, 1, 1];
  constructor(readonly width: number, readonly height: number) {}
}

export class PyramidPlanner {
  readonly level0Pool: TileStore;
  readonly previewPool: TileStore;
  private readonly scratch: TileSlot[] = [];
  private readonly scratchSlots = new Set<TileSlot>();
  private readonly caches = new Map<CanvasId, CanvasCache>();
  /** Regions asked for through `request()` since the last plan. */
  private requests: { canvasId: CanvasId; level: number; rect: Rect }[] = [];
  private frame = 0;

  constructor(
    level0Capacity = COMPOSITE_LEVEL0_PAGES * SLOTS_PER_PAGE,
    previewCapacity = COMPOSITE_PREVIEW_PAGES * SLOTS_PER_PAGE,
    private readonly budgetPerFrame = COMPOSITES_PER_FRAME,
  ) {
    this.level0Pool = new TileStore(level0Capacity);
    this.previewPool = new TileStore(previewCapacity);
    for (let i = 0; i < budgetPerFrame; i++) this.scratch.push(this.level0Pool.allocate()!);
    for (const slot of this.scratch) this.scratchSlots.add(slot);
  }

  /** True for the per-frame scratch tiles (level-0 composites that are only downsampled, not kept). */
  isScratch(slot: TileSlot): boolean {
    return this.scratchSlots.has(slot);
  }

  /**
   * True if a tile of `level` over `rect` is out of date but needed this
   * frame, so a later frame will bring it up to date. Inheritors that
   * sampled it are composited again then. Tiles that aren't cached, or that
   * nothing needs, return false: waiting for them could take forever.
   */
  willUpdate(canvasId: CanvasId, level: number, rect: Rect): boolean {
    const cache = this.caches.get(canvasId);
    if (!cache) return false;
    const changed = new Set([...cache.pending].map((key0) => ancestorKey(key0, level)));
    return levelTilesInRect(cache, rect, level).some((key) => {
      const tile = cache.levels[level]!.get(key);
      return tile !== undefined && tile.lastUsed === this.frame && (tile.todo !== null || changed.has(key));
    });
  }

  /** True if content changed inside `rect` (canvas px) and hasn't reached the cached tiles yet. */
  hasPendingChanges(canvasId: CanvasId, rect: Rect): boolean {
    const cache = this.caches.get(canvasId);
    if (!cache || cache.pending.size === 0) return false;
    return levelTilesInRect(cache, rect, 0).some((key) => cache.pending.has(key));
  }

  /**
   * Drop one cached tile (it was built at lower quality than its level
   * promises). The GPU may still read it this frame; its slot is only reused
   * from the next plan on.
   */
  forgetTile(canvasId: CanvasId, level: number, key: TileKey): void {
    const cache = this.caches.get(canvasId);
    const tile = cache?.levels[level]!.get(key);
    if (!cache || !tile || this.isScratch(tile.slot)) return;
    cache.levels[level]!.delete(key);
    this.poolFor(level).release(tile.slot);
  }

  /** Content changed at these level-0 keys (or everywhere). */
  invalidate(canvasId: CanvasId, keys: readonly TileKey[] | 'all'): void {
    const cache = this.caches.get(canvasId);
    if (!cache) return;
    const list = keys === 'all' ? levelTilesInRect(cache, { x: 0, y: 0, width: cache.width, height: cache.height }, 0) : keys;
    for (const k of list) cache.pending.add(k);
  }

  /** Cached tiles per level, for the HUD and tests. */
  cachedTiles(canvasId: CanvasId): number[] {
    return this.caches.get(canvasId)?.levels.map((m) => m.size) ?? [];
  }

  /** True if the tile is cached and complete. */
  isComplete(canvasId: CanvasId, level: number, key: TileKey): boolean {
    return this.caches.get(canvasId)?.levels[level]!.get(key)?.todo === null;
  }

  /**
   * Phase 3 hook: build this canvas's composite at `level` over `rect`
   * (canvas px) as if it were on screen, after the on-screen tiles. Call it
   * every frame the region is needed; unused tiles are evicted as usual.
   */
  request(canvasId: CanvasId, level: number, rect: Rect): void {
    this.requests.push({ canvasId, level: Math.max(0, Math.min(PYRAMID_LEVELS - 1, level)), rect });
  }

  /**
   * Phase 3 hook: how to draw a canvas's composite over `rect` at `level`
   * right now, as the same quads the display pass uses (a tile of that level
   * where it is ready, else a coarser cached tile, else plain paper).
   */
  tiledView(canvasId: CanvasId, level: number, rect: Rect): DisplayQuad[] {
    const cache = this.caches.get(canvasId);
    if (!cache) return [];
    const bounds = { x: 0, y: 0, width: cache.width, height: cache.height };
    return levelTilesInRect(cache, rect, level).map((key) => {
      const canvasRect = intersect(intersect(levelTileRect(level, key), bounds)!, rect)!;
      return this.displayQuad(canvasId, cache, level, key, canvasRect);
    });
  }

  /**
   * Plan one frame.
   * @param canvases every canvas, back to front
   * @param visible the workspace rect on screen
   * @param level the pyramid level that matches the zoom
   */
  plan(canvases: readonly PlannerCanvas[], visible: Rect, level: number): FramePlan {
    this.frame++;
    const out: FramePlan = { composites: [], downsamples: [], display: [], overBudget: false };
    let budget = this.budgetPerFrame;
    let scratchUsed = 0;
    this.syncCaches(canvases);

    const localVisible = (c: PlannerCanvas): Rect | null => {
      const r = intersect(c.placement, visible);
      return r && { x: r.x - c.placement.x, y: r.y - c.placement.y, width: r.width, height: r.height };
    };
    const onScreen = canvases.filter((c) => localVisible(c) !== null);
    // On-screen canvases front to back, then the rest; sources before the canvases that inherit them.
    const priority = [...[...onScreen].reverse(), ...canvases.filter((c) => !onScreen.includes(c))].sort(
      (a, b) => (a.depth ?? 0) - (b.depth ?? 0),
    );

    // 1. The tiles each canvas needs: the display level while on screen, and the pinned levels always.
    const needed: { c: PlannerCanvas; level: number; tile: CachedTile }[] = [];
    for (const c of priority) {
      const cache = this.caches.get(c.id)!;
      const wanted: [number, TileKey][] = [];
      const local = localVisible(c);
      if (local) for (const key of levelTilesInRect(cache, local, level)) wanted.push([level, key]);
      const full = { x: 0, y: 0, width: cache.width, height: cache.height };
      for (let l = PINNED_PREVIEW_LEVEL; l < PYRAMID_LEVELS; l++) {
        for (const key of levelTilesInRect(cache, full, l)) wanted.push([l, key]);
      }
      for (const r of this.requests) {
        if (r.canvasId === c.id) for (const key of levelTilesInRect(cache, r.rect, r.level)) wanted.push([r.level, key]);
      }
      for (const [l, key] of wanted) {
        const tile = this.ensureTile(cache, l, key);
        if (tile) needed.push({ c, level: l, tile });
      }
    }

    /**
     * A level-0 composite of `key` to read from: the cached tile (recomposited
     * if `refresh` or not yet built), null for plain paper, a scratch tile, or
     * undefined when over budget this frame. Recompositing a cached tile is not
     * limited by the budget, so a stroke in progress never lags.
     */
    const level0Source = (c: PlannerCanvas, cache: CanvasCache, key: TileKey, refresh: boolean): TileSlot | null | undefined => {
      const cached = cache.levels[0]!.get(key);
      if (cached && (refresh || cached.todo !== null)) {
        out.composites.push({ canvasId: c.id, key, dst: cached.slot });
        cached.todo = null;
        return cached.slot;
      }
      if (cached) return cached.slot;
      if (c.isPaperOnly(key)) return null;
      if (budget <= 0 || scratchUsed >= this.scratch.length) {
        out.overBudget = true;
        return undefined;
      }
      budget--;
      const dst = this.scratch[scratchUsed++]!;
      out.composites.push({ canvasId: c.id, key, dst });
      return dst;
    };
    const downsampleInto = (c: PlannerCanvas, src: TileSlot | null, tile: CachedTile, l: number, key0: TileKey): void => {
      const { tx, ty } = tileCoords(key0);
      const size = TILE_SIZE >> l;
      const parent = tileCoords(ancestorKey(key0, l));
      out.downsamples.push({
        canvasId: c.id, key: ancestorKey(key0, l), src, paper: c.paper, dst: tile.slot, level: l,
        x: (tx - (parent.tx << l)) * size, y: (ty - (parent.ty << l)) * size, size,
      });
    };

    // 2. Changed content reaches every cached tile that shows it.
    for (const c of priority) {
      const cache = this.caches.get(c.id)!;
      for (const key0 of [...cache.pending]) {
        const coarser: { tile: CachedTile; l: number }[] = [];
        for (let l = 1; l < PYRAMID_LEVELS; l++) {
          const tile = cache.levels[l]!.get(ancestorKey(key0, l));
          // A tile still being built picks the key up from its to-do list instead.
          if (tile && !(tile.todo?.includes(key0) ?? false)) coarser.push({ tile, l });
        }
        const cached0 = cache.levels[0]!.get(key0);
        if (!cached0 && coarser.length === 0) {
          cache.pending.delete(key0); // nothing cached shows this tile
          continue;
        }
        if (!c.isReady(key0)) continue; // wait for its layer tiles
        const src = level0Source(c, cache, key0, true);
        if (src === undefined) continue; // over budget: next frame
        for (const { tile, l } of coarser) downsampleInto(c, src, tile, l, key0);
        cache.pending.delete(key0);
      }
    }

    // 3. Build tiles that aren't complete yet (on-screen ones first).
    for (const { c, level: l, tile } of needed) {
      if (tile.todo === null) continue;
      const cache = this.caches.get(c.id)!;
      if (l === 0) {
        const key0 = tile.todo[0]!;
        if (!c.isReady(key0)) continue;
        if (budget <= 0) {
          out.overBudget = true;
          continue;
        }
        budget--;
        level0Source(c, cache, key0, true);
        continue;
      }
      while (tile.todo.length > 0) {
        const key0 = tile.todo[0]!;
        if (!c.isReady(key0)) break;
        const src = level0Source(c, cache, key0, false);
        if (src === undefined) break;
        downsampleInto(c, src, tile, l, key0);
        tile.todo.shift();
      }
      if (tile.todo.length === 0) tile.todo = null;
    }

    // 4. Display, back to front: the wanted tile, else a coarser cached one, else paper.
    for (const c of onScreen) {
      const cache = this.caches.get(c.id)!;
      for (const key of levelTilesInRect(cache, localVisible(c)!, level)) {
        const tileRect = levelTileRect(level, key);
        const canvasRect = intersect(tileRect, { x: 0, y: 0, width: cache.width, height: cache.height })!;
        out.display.push(this.displayQuad(c.id, cache, level, key, canvasRect));
      }
    }
    this.requests = [];
    return out;
  }

  private displayQuad(canvasId: CanvasId, cache: CanvasCache, level: number, key: TileKey, canvasRect: Rect): DisplayQuad {
    const { tx, ty } = tileCoords(key);
    for (let l = level; l < PYRAMID_LEVELS; l++) {
      const shift = l - level;
      const tile = cache.levels[l]!.get(tileKey(tx >> shift, ty >> shift));
      if (!tile || tile.todo !== null) continue;
      tile.lastUsed = this.frame;
      const origin = levelTileRect(l, tileKey(tx >> shift, ty >> shift));
      const scale = 1 / 2 ** l;
      return {
        canvasId, canvasRect, kind: 'tile', pool: l === 0 ? 'level0' : 'preview', slot: tile.slot,
        texels: {
          x: (canvasRect.x - origin.x) * scale, y: (canvasRect.y - origin.y) * scale,
          width: canvasRect.width * scale, height: canvasRect.height * scale,
        },
      };
    }
    return { canvasId, canvasRect, kind: 'paper', color: cache.paper };
  }

  /** Create caches for new canvases; drop caches of removed or resized canvases. */
  private syncCaches(canvases: readonly PlannerCanvas[]): void {
    const byId = new Map(canvases.map((c) => [c.id, c]));
    for (const [id, cache] of this.caches) {
      const c = byId.get(id);
      if (!c || c.placement.width !== cache.width || c.placement.height !== cache.height) this.dropCache(id);
    }
    for (const c of canvases) {
      if (!this.caches.has(c.id)) this.caches.set(c.id, new CanvasCache(c.placement.width, c.placement.height));
      this.caches.get(c.id)!.paper = c.paper;
    }
  }

  private dropCache(id: CanvasId): void {
    const cache = this.caches.get(id);
    if (!cache) return;
    cache.levels.forEach((tiles, l) => {
      for (const t of tiles.values()) this.poolFor(l).release(t.slot);
    });
    this.caches.delete(id);
  }

  private poolFor(level: number): TileStore {
    return level === 0 ? this.level0Pool : this.previewPool;
  }

  /** The cached tile, or a new (incomplete) one; null if its pool is full of tiles in use. */
  private ensureTile(cache: CanvasCache, level: number, key: TileKey): CachedTile | null {
    const existing = cache.levels[level]!.get(key);
    if (existing) {
      existing.lastUsed = this.frame;
      return existing;
    }
    const slot = this.allocate(level);
    if (slot === null) return null;
    const rect = intersect(levelTileRect(level, key), { x: 0, y: 0, width: cache.width, height: cache.height })!;
    const tile: CachedTile = { slot, lastUsed: this.frame, todo: levelTilesInRect(cache, rect, 0) };
    cache.levels[level]!.set(key, tile);
    // Content changes inside a tile being built are picked up by the build itself.
    return tile;
  }

  /** Allocate from the level's pool, evicting the least recently shown unpinned tile if needed. */
  private allocate(level: number): TileSlot | null {
    const pool = this.poolFor(level);
    const slot = pool.allocate();
    if (slot !== null) return slot;
    let victim: { cache: CanvasCache; l: number; key: TileKey; tile: CachedTile } | null = null;
    for (const cache of this.caches.values()) {
      for (let l = 0; l < Math.min(PINNED_PREVIEW_LEVEL, PYRAMID_LEVELS); l++) {
        if ((l === 0) !== (level === 0)) continue; // same pool only
        for (const [key, tile] of cache.levels[l]!) {
          if (tile.lastUsed < this.frame && (!victim || tile.lastUsed < victim.tile.lastUsed)) victim = { cache, l, key, tile };
        }
      }
    }
    if (!victim) return null;
    victim.cache.levels[victim.l]!.delete(victim.key);
    pool.release(victim.tile.slot);
    return pool.allocate();
  }
}
