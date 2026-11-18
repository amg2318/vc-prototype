/**
 * Tunable limits. These are expected to change after measuring memory on the
 * iPad, so they live in one place.
 */

/** Canvas size in pixels. Must be a multiple of TILE_SIZE. */
export const CANVAS_WIDTH = 4096;
export const CANVAS_HEIGHT = 4096;

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
 * Upper bound on pages. Also bounded by texture bindings: the compositor binds
 * every page at once, and WebGL2 on iOS guarantees only 16 texture units.
 * 8 pages = 2048 tiles = 512 MB of tile memory (document + undo history).
 */
export const MAX_ATLAS_PAGES = 8;

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
  /** Touch-and-hold for the eyedropper. */
  holdDurationMs: 500,
  holdMaxMovementPx: 8,
  /**
   * Touches with a contact larger than this (PointerEvent width/height) are
   * treated as a palm: they never tap or trigger the eyedropper. Devices that
   * don't report contact size report ~1 px, so this check is then inactive.
   */
  palmContactPx: 40,
};

// --- derived values (not meant to be edited) --------------------------------

export const TILES_X = CANVAS_WIDTH / TILE_SIZE;
export const TILES_Y = CANVAS_HEIGHT / TILE_SIZE;
export const TILE_COUNT = TILES_X * TILES_Y;
export const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
export const PAGE_SIDE_TILES = ATLAS_PAGE_SIZE / TILE_SIZE;
export const SLOTS_PER_PAGE = PAGE_SIDE_TILES * PAGE_SIDE_TILES;
export const MAX_TILE_SLOTS = SLOTS_PER_PAGE * MAX_ATLAS_PAGES;
export const PAGE_BYTES = ATLAS_PAGE_SIZE * ATLAS_PAGE_SIZE * 4;
