/**
 * Tunable limits. These are expected to change after measuring memory on the
 * iPad, so they live in one place.
 */

/** Canvas size in pixels. Must be a multiple of TILE_SIZE. */
export const CANVAS_WIDTH = 4096;
export const CANVAS_HEIGHT = 4096;

/** Largest canvas side in pixels (tile keys assume at most 4096 / TILE_SIZE tiles per row). */
export const MAX_CANVAS_SIZE = 4096;

/** Raster layers are sparse grids of TILE_SIZE × TILE_SIZE tiles. */
export const TILE_SIZE = 256;
export const MAX_LAYERS = 32;

/**
 * GPU tile pool: tiles live in square "atlas page" textures, each holding
 * (ATLAS_PAGE_SIZE / TILE_SIZE)² tile slots. Pages are allocated on demand.
 * 4096² RGBA8 = 64 MB per page, 256 slots per page.
 */
export const ATLAS_PAGE_SIZE = 4096;
/**
 * Upper bound on layer tile pages. Also bounded by texture bindings: the
 * compositor binds every page at once, and WebGL2 on iOS guarantees only 16
 * texture units. 8 pages = 2048 tiles = 512 MB.
 */
export const MAX_ATLAS_PAGES = 8;

/**
 * Tile residency: documents and undo history refer to tiles by id; only
 * recently used tiles are kept on the GPU, within this budget (default 256 MB
 * = 1024 tiles; `?layerBudgetMB=` overrides it, up to MAX_ATLAS_PAGES pages).
 * Least recently used tiles are evicted: read back, deflate-compressed, and
 * kept in JS memory until needed again.
 */
export const LAYER_GPU_BUDGET_BYTES = 256 * 1024 * 1024;
/** Upper bound on tile ids (layers + undo history, on the GPU or compressed). */
export const MAX_TILE_IDS = 65536;
/** Evicted tiles being decompressed at once. */
export const MAX_LOADS_IN_FLIGHT = 16;
/** Reloaded tiles uploaded to the GPU per frame (each is 256 KB). */
export const UPLOADS_PER_FRAME = 32;

/**
 * Composite cache: each canvas's composite is a pyramid of tiles at full,
 * ½, ¼, ⅛ and 1/16 resolution (levels 0–4), cached in two GPU pools:
 *  - level 0 (full resolution), including per-frame scratch tiles;
 *  - levels 1–4 (previews). Levels from PINNED_PREVIEW_LEVEL up are never
 *    evicted, so every canvas always has something to show.
 * Least recently shown tiles are evicted when a pool is full.
 */
export const COMPOSITE_LEVEL0_PAGES = 1;
export const COMPOSITE_PREVIEW_PAGES = 2;
export const PINNED_PREVIEW_LEVEL = 3;
/** Level-0 composites the planner may add per frame beyond the visible, already-cached tiles. */
export const COMPOSITES_PER_FRAME = 48;

/** Undo history may hold this many bytes of tiles that the document no longer uses. */
export const HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;

/** Layer thumbnails are this many pixels on their longest side. */
export const THUMBNAIL_SIZE = 64;
/** Wait this long after the last change before refreshing a layer thumbnail. */
export const THUMBNAIL_DELAY_MS = 300;

/** Touch gesture thresholds (CSS px and ms). */
export const GESTURES = {
  /** A multi-finger tap must lift within this time… */
  tapMaxDurationMs: 250,
  /** …and no finger may move further than this. */
  tapMaxMovementPx: 12,
  /** Touch-and-hold for the eyedropper (it also discards the tiny stroke the finger started). */
  holdDurationMs: 400,
  holdMaxMovementPx: 8,
  /**
   * A second finger landing within this time of a one-finger stroke starting,
   * before that finger moved this far, cancels the stroke (it was the start
   * of a pinch or a two-finger tap).
   */
  strokeCancelMs: 200,
  strokeCancelMovementPx: 30,
  /**
   * Touches with a contact larger than this (PointerEvent width/height) are
   * treated as a palm: they never draw, pan, tap or trigger the eyedropper.
   * A fingertip is about 40–50 px wide (40 rejected every finger), a palm far
   * more. Not yet measured on an iPad: the HUD's "last touch" line shows the
   * reported size. Devices that don't report contact size report ~1 px, so
   * this check is then inactive.
   */
  palmContactPx: 100,
};

// --- derived values (not meant to be edited) --------------------------------

export const TILES_X = CANVAS_WIDTH / TILE_SIZE;
export const TILES_Y = CANVAS_HEIGHT / TILE_SIZE;
export const TILE_COUNT = TILES_X * TILES_Y;
export const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
export const PAGE_SIDE_TILES = ATLAS_PAGE_SIZE / TILE_SIZE;
export const SLOTS_PER_PAGE = PAGE_SIDE_TILES * PAGE_SIDE_TILES;
export const MAX_TILE_SLOTS = SLOTS_PER_PAGE * MAX_ATLAS_PAGES;
export const LAYER_GPU_SLOTS = Math.min(MAX_TILE_SLOTS, Math.floor(LAYER_GPU_BUDGET_BYTES / TILE_BYTES));
export const PAGE_BYTES = ATLAS_PAGE_SIZE * ATLAS_PAGE_SIZE * 4;
