import { ATLAS_PAGE_SIZE, MAX_LAYERS, PAGE_SIDE_TILES, TILES_X, TILE_COUNT, TILE_SIZE, THUMBNAIL_SIZE } from '../config';
import { BLEND_MODE_IDS } from '../document/blend';
import { BLOCK_LOOKUP_WIDTH, BLOCK_PAGES, BLOCK_VEC4S, STAGING_SIZE } from './blockPacking';
import { slotLocation, tileCoords, type TileKey, type TileSlot } from '../document/tiles';
import type { CanvasRenderState, MergeJob, Rgba, StrokeStyle } from './renderer';
import type { Size } from './renderCore';

/** The parts of a canvas's render state the compositor reads. */
export type CompositeInput = Pick<CanvasRenderState, 'paper' | 'paperVisible' | 'sources' | 'liveStroke'>;

/** The paper as a premultiplied colour: opaque, or fully transparent when hidden. */
export function paperRgba(state: Pick<CanvasRenderState, 'paper' | 'paperVisible'>): Rgba {
  return state.paperVisible === false ? [0, 0, 0, 0] : [...state.paper, 1];
}

/**
 * Turns compositor and merge inputs into the flat arrays both GPU backends
 * upload. Keeping this out of the backends means the data layout is defined
 * (and tested) once.
 */

/** Maximum number of compositor sources (one row each in the lookup table). */
export const MAX_SOURCES = MAX_LAYERS;

/**
 * Tile lookup table: a TILE_COUNT × MAX_SOURCES integer texture. Texel
 * (tileKey, sourceIndex) holds slot + 1, or 0 for "no tile here".
 * `slotOf` maps the document's tile ids to GPU slots.
 */
export function packLookup(
  state: CompositeInput,
  slotOf: (id: number) => number | undefined = (id) => id,
  target = new Uint32Array(TILE_COUNT * MAX_SOURCES),
): Uint32Array {
  target.fill(0);
  state.sources.slice(0, MAX_SOURCES).forEach((source, row) => {
    for (const [key, id] of source.tiles) {
      const slot = slotOf(id);
      if (slot !== undefined) target[row * TILE_COUNT + key] = slot + 1;
    }
  });
  return target;
}

/**
 * Composite uniforms, as vec4s:
 *   [0] paper, premultiplied (all zero when hidden)
 *   [1] live stroke rgb, opacity
 *   [2] source count, live stroke source index (-1 = none), stroke mode (0 paint, 1 erase),
 *       render target size (an atlas page, or the staging target for canvases with a block)
 *   [3 + i] source i: opacity, blend mode id, 0, 0
 *   [BLOCK_UNIFORM_BASE …] the inherited block (see packBlockUniforms; all zero = no block)
 */
export const BLOCK_UNIFORM_BASE = 3 + MAX_SOURCES;
export const COMPOSITE_UNIFORM_VEC4S = BLOCK_UNIFORM_BASE + BLOCK_VEC4S;

/** `block`: the block's uniforms from packBlockUniforms, if the canvas draws one. */
export function packCompositeUniforms(state: CompositeInput, block: Float32Array | null = null): Float32Array {
  const u = new Float32Array(COMPOSITE_UNIFORM_VEC4S * 4);
  u.set(paperRgba(state), 0);
  const live = state.liveStroke;
  if (live) u.set([...live.style.color, live.style.opacity], 4);
  u.set(
    [
      Math.min(state.sources.length, MAX_SOURCES),
      live ? live.sourceIndex : -1,
      live?.style.mode === 'erase' ? 1 : 0,
      block ? STAGING_SIZE : ATLAS_PAGE_SIZE,
    ],
    8,
  );
  state.sources.slice(0, MAX_SOURCES).forEach((s, i) => {
    u.set([s.opacity, BLEND_MODE_IDS[s.blendMode], 0, 0], 12 + i * 4);
  });
  if (block) u.set(block, BLOCK_UNIFORM_BASE * 4);
  return u;
}

/**
 * Merge instances, 12 floats each:
 *   dst slot x, y (in its page) · tile origin x, y (canvas) · colour rgb, opacity · mode, canvas width, height, 0
 * The canvas size clips the stroke: pixels outside a canvas stay transparent.
 */
export const MERGE_INSTANCE_FLOATS = 12;

export function packMergeInstance(job: MergeJob, style: StrokeStyle, canvas: Size, target: Float32Array, index: number): void {
  const dst = slotLocation(job.dst);
  const { tx, ty } = tileCoords(job.key);
  target.set(
    [
      dst.x, dst.y, tx * TILE_SIZE, ty * TILE_SIZE,
      ...style.color, style.opacity,
      style.mode === 'erase' ? 1 : 0, canvas.width, canvas.height, 0,
    ],
    index * MERGE_INSTANCE_FLOATS,
  );
}

/** Group merge jobs by the atlas page they write to (one draw call per page). */
export function groupByDstPage(jobs: readonly MergeJob[]): Map<number, MergeJob[]> {
  const groups = new Map<number, MergeJob[]>();
  for (const job of jobs) {
    const page = slotLocation(job.dst).page;
    const list = groups.get(page) ?? [];
    list.push(job);
    groups.set(page, list);
  }
  return groups;
}

/** Thumbnail pixels per tile along each axis (must divide evenly; 64 / 16 = 4). */
export const THUMBNAIL_PIXELS_PER_TILE = THUMBNAIL_SIZE / TILES_X;

/** Thumbnail instances: slot, tile x, tile y, 0. */
export function packThumbnailInstances(tiles: readonly [TileKey, TileSlot][]): Float32Array {
  const out = new Float32Array(tiles.length * 4);
  tiles.forEach(([key, slot], i) => {
    const { tx, ty } = tileCoords(key);
    out.set([slot, tx, ty, 0], i * 4);
  });
  return out;
}

/** Empty-check readback: each tile is reduced to a 16 × 16 block of max-alpha values. */
export const EMPTY_CHECK_BLOCK = 16;
/** Tiles checked per pass (target width = EMPTY_CHECK_BATCH × 16 px). */
export const EMPTY_CHECK_BATCH = 64;

/** True for each tile whose 16 × 16 block (RGBA8 rows of the readback) is all zero alpha. */
export function emptyTilesFromReadback(pixels: Uint8Array, rowWidthPx: number, count: number): boolean[] {
  const result: boolean[] = [];
  for (let t = 0; t < count; t++) {
    let empty = true;
    for (let y = 0; y < EMPTY_CHECK_BLOCK && empty; y++) {
      for (let x = 0; x < EMPTY_CHECK_BLOCK; x++) {
        if (pixels[(y * rowWidthPx + t * EMPTY_CHECK_BLOCK + x) * 4 + 3]! > 0) {
          empty = false;
          break;
        }
      }
    }
    result.push(empty);
  }
  return result;
}

/** Shader constants shared by WGSL and GLSL sources. */
export const SHADER_CONSTANTS = {
  TILE_SIZE,
  TILES_X,
  PAGE_SIDE_TILES,
  SLOTS_PER_PAGE: PAGE_SIDE_TILES * PAGE_SIDE_TILES,
  MAX_SOURCES,
  THUMBNAIL_PIXELS_PER_TILE,
  EMPTY_CHECK_BLOCK,
  BLOCK_UNIFORM_BASE,
  BLOCK_LOOKUP_WIDTH,
  BLOCK_PAGES,
};
