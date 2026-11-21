import { COMPOSITE_LEVEL0_PAGES, COMPOSITE_PREVIEW_PAGES, TILE_COUNT, TILE_SIZE, TILES_X } from '../config';
import {
  cropRect,
  invertAffine,
  sourceToInheritor,
  transformRect,
  type BlockBlendMode,
  type Effect,
  type InheritedBlock,
  type Size,
} from '../document/inheritedBlock';
import { intersect, type Rect } from '../workspace/coords';
import { levelSpan, PYRAMID_LEVELS } from './pyramid';
import type { CompositeTile } from './renderer';

/**
 * How the compositor draws an inherited block: which pyramid level of the
 * source to sample, the uniforms that describe the block, and the lookup
 * table that says where each part of the source's cached composite is.
 * Shared by both GPU backends; pure, so it is unit-tested.
 */

/** Uniform vec4s describing the block (after the layer sources' uniforms). */
export const BLOCK_VEC4S = 8;
/** Effects applied per block, at most (one of each kind). */
export const MAX_EFFECTS = 3;
/** Lookup texture width: two RGBA32F texels per source cell, TILES_X cells per row. */
export const BLOCK_LOOKUP_WIDTH = TILE_COUNT * 2;

export const BLOCK_BLEND_IDS: Record<BlockBlendMode, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3 };
const EFFECT_IDS: Record<Effect['kind'], number> = { grayscale: 1, invert: 2, posterize: 3 };

/**
 * The source pyramid level whose resolution matches the block on the
 * inheritor (a block drawn at half size samples level 1), plus `coarser`
 * levels when the inheritor itself is only needed at a coarser level.
 */
export function blockLevel(scale: number, coarser = 0): number {
  const matching = scale >= 1 ? 0 : Math.floor(Math.log2(1 / scale) + 1e-9);
  return Math.max(0, Math.min(PYRAMID_LEVELS - 1, matching + coarser));
}

/**
 * The part of the source that `rect` (inheritor pixels) shows, in source
 * pixels, grown by a pixel for bilinear filtering; null if none.
 */
export function blockSourceRect(block: InheritedBlock, sourceSize: Size, rect: Rect): Rect | null {
  const toSource = invertAffine(sourceToInheritor(block, sourceSize));
  const r = transformRect(toSource, rect);
  const grown = { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 };
  const crop = intersect(cropRect(block.crop, sourceSize), { x: 0, y: 0, ...sourceSize });
  return crop && intersect(grown, crop);
}

/** The block's bounding box on the inheritor (pixels), or null if it misses the canvas. */
export function blockBounds(block: InheritedBlock, sourceSize: Size, inheritorSize: Size): Rect | null {
  const crop = cropRect(block.crop, sourceSize);
  return intersect(transformRect(sourceToInheritor(block, sourceSize), crop), { x: 0, y: 0, ...inheritorSize });
}

/**
 * Block uniforms, as vec4s:
 *   [0] inheritor → source matrix a, b, c, d
 *   [1] matrix e, f · source cell size at the sampled level (px) · 1 = draw the block
 *   [2] crop in source px: x0, y0, x1, y1
 *   [3] opacity, blend mode id, effect count, 0
 *   [4 + i] effect i: id (1 grayscale, 2 invert, 3 posterize), posterize levels, 0, 0
 *   [7] unused
 */
export function packBlockUniforms(block: InheritedBlock, sourceSize: Size, level: number): Float32Array {
  const u = new Float32Array(BLOCK_VEC4S * 4);
  const m = invertAffine(sourceToInheritor(block, sourceSize));
  const crop = cropRect(block.crop, sourceSize);
  const effects = block.effects.slice(0, MAX_EFFECTS);
  u.set([m.a, m.b, m.c, m.d, m.e, m.f, levelSpan(level), 1], 0);
  u.set([crop.x, crop.y, crop.x + crop.width, crop.y + crop.height], 8);
  u.set([block.opacity, BLOCK_BLEND_IDS[block.blendMode], effects.length, 0], 12);
  effects.forEach((e, i) => u.set([EFFECT_IDS[e.kind], e.kind === 'posterize' ? e.levels : 0, 0, 0], 16 + i * 4));
  return u;
}

/**
 * Lookup table for the source's composite at one level: for each cell (one
 * tile of that level, TILES_X per row), two RGBA32UI texels:
 *   [0] texture + 1 (level-0 pages first, then preview pages; 0 = plain paper),
 *       page texel x, y of the cell's origin, pyramid level of that tile
 *       (a coarser cached tile stands in until the cell's own is built)
 *   [1] the tile's top-left texel x, y (bilinear filtering stays inside it),
 *       or the paper colour as premultiplied 0–255 rgba
 * `tiles` comes from `compositeTiles(source, level, whole source)`, which
 * already falls back to coarser cached tiles. All values are whole numbers.
 */
export function packBlockLookup(tiles: readonly CompositeTile[], level: number, target = new Uint32Array(BLOCK_LOOKUP_WIDTH * 4)): Uint32Array {
  target.fill(0);
  const span = levelSpan(level);
  for (const t of tiles) {
    const at = (Math.floor(t.canvasRect.y / span) * TILES_X + Math.floor(t.canvasRect.x / span)) * 8;
    if (t.kind === 'paper') {
      target.set([0, 0, 0, 0, ...t.color.map((c) => Math.round(c * 255))], at);
      continue;
    }
    const texture = t.pool === 'level0' ? t.page : COMPOSITE_LEVEL0_PAGES + t.page;
    const tileLevel = Math.round(Math.log2(t.canvasRect.width / t.texels.width));
    target.set([texture + 1, t.x + t.texels.x, t.y + t.texels.y, tileLevel, t.x, t.y, 0, 0], at);
  }
  return target;
}

/** Composite page textures a block can sample (level-0 pages, then preview pages). */
export const BLOCK_PAGES = COMPOSITE_LEVEL0_PAGES + COMPOSITE_PREVIEW_PAGES;

/** Staging target for composites that read composite pages: TILES_PER_SIDE² tiles. */
export const STAGING_TILES_PER_SIDE = 8;
export const STAGING_SIZE = STAGING_TILES_PER_SIDE * TILE_SIZE;
export const STAGING_TILES = STAGING_TILES_PER_SIDE * STAGING_TILES_PER_SIDE;

/** Top-left pixel of staging tile `i`. */
export function stagingOrigin(i: number): { x: number; y: number } {
  return { x: (i % STAGING_TILES_PER_SIDE) * TILE_SIZE, y: Math.floor(i / STAGING_TILES_PER_SIDE) * TILE_SIZE };
}
