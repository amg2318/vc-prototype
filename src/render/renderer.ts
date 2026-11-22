import type { Dab } from '../brush/dabs';
import type { BlendMode, RGB } from '../document/blend';
import type { InheritedBlock } from '../document/inheritedBlock';
import type { MergeJob, StrokeMode } from '../document/editor';
import type { CanvasId } from '../document/paintDocument';
import type { RetileJob } from '../document/retile';
import type { TileStore } from '../document/tileStore';
import type { TileId, TileKey } from '../document/tiles';
import type { Placement, Rect } from '../workspace/coords';

export type { Dab, MergeJob, RetileJob };

export type RendererKind = 'webgpu' | 'webgl2';

export interface StrokeStyle {
  /** sRGB 0..1 (ignored when erasing). */
  color: RGB;
  /** Applied once to the whole stroke mask (no build-up within a stroke). */
  opacity: number;
  mode: StrokeMode;
}

/**
 * One entry in a canvas's layer stack. Phase 2 only has raster layers;
 * Phase 3 adds inherited blocks (a transformed, read-only image of another
 * canvas's composite) as another `kind`, inserted at the bottom.
 */
export interface RasterSource {
  kind: 'raster';
  opacity: number;
  blendMode: BlendMode;
  tiles: ReadonlyMap<TileKey, TileId>;
}
export type CompositeSource = RasterSource;

/** What the compositor needs to know about one canvas. */
export interface CanvasRenderState {
  id: CanvasId;
  placement: Placement;
  /** Non-erasable background colour, below every source. */
  paper: RGB;
  /** False: no paper, the canvas is transparent (absent = shown). */
  paperVisible?: boolean;
  /** Visible sources, bottom to top. */
  sources: CompositeSource[];
  /** The stroke being drawn on this canvas, shown on `sources[sourceIndex]` until merged. */
  liveStroke: { sourceIndex: number; style: StrokeStyle } | null;
  /**
   * The inherited block, drawn below every source: only when it is linked
   * and visible (null or absent otherwise). Blocks are immutable values, so
   * a different object means the block changed.
   */
  inherited?: InheritedBlock | null;
}

/** A flat-coloured rectangle in workspace coordinates (premultiplied RGBA), drawn above all canvases. */
/**
 * Phase 3: one piece of a canvas's composite, ready to be drawn. A tile
 * lives in a composite page texture of the backend: pool 'level0' (full
 * resolution) or 'preview' (coarser levels); `x`, `y` are its top-left texel
 * in that page and `texels` the region to sample inside the tile. Regions
 * with nothing cached yet come back as plain paper.
 */
export type CompositeTile =
  | { kind: 'tile'; canvasRect: Rect; pool: 'level0' | 'preview'; page: number; x: number; y: number; texels: Rect }
  | { kind: 'paper'; canvasRect: Rect; color: Rgba };

/** A premultiplied colour, 0..1 (paper is [r, g, b, 1], or all zero when hidden). */
export type Rgba = [number, number, number, number];

export interface OverlayRect {
  rect: Rect;
  color: [number, number, number, number];
}

/** A parallelogram in workspace coordinates (e.g. a rotated stroke of an arrow); premultiplied colour. */
export interface OverlayQuad {
  origin: { x: number; y: number };
  xAxis: { x: number; y: number };
  yAxis: { x: number; y: number };
  color: Rgba;
}

/** What the overlay pass draws, above every canvas. */
export type OverlayShape = OverlayRect | OverlayQuad;

/** What to draw: the camera as a workspace → clip matrix (double precision) and the zoom level. */
export interface ViewState {
  /** Column-major 3×3 matrix from workspace coordinates to clip space. */
  workspaceToClip: Float64Array;
  /** The workspace rect on screen (for culling). */
  visible: Rect;
  /** Canvas pixels per device pixel (above 1 = zoomed out). */
  canvasPxPerDevicePx: number;
}

export interface FrameInfo {
  /** performance.now() right after the frame's GPU work was submitted. */
  submittedAt: number;
  /** Resolves with performance.now() when the GPU has finished (WebGPU only). */
  gpuDone: Promise<number> | null;
  /** Level-0 tiles composited this frame. */
  compositedTiles: number;
  /** Preview regions downsampled this frame. */
  downsampledTiles: number;
  /** Canvases on screen. */
  visibleCanvases: number;
  /** CPU time spent planning and encoding the composite work. */
  compositeCpuMs: number;
  /** GPU time of the composite passes in ms, when the device supports timestamp queries. */
  compositeGpuMs?: Promise<number>;
  /** True if more work is ready for the next frame (draw another one). */
  moreWork: boolean;
  /** Phase 3: inheritors that changed through an arrow this frame. */
  inheritorsUpdated: number;
  /** Phase 3: inheritors with changes not yet shown (off screen during a stroke, or over budget). */
  staleInheritors: number;
  /**
   * Phase 3: inheritors this frame brought fully up to date, with their
   * chain depth and the time from the source change reaching the renderer
   * to this frame's GPU work being submitted.
   */
  propagation: { depth: number; ms: number }[];
}

/** 0..255 per channel. */
export type Rgba8 = [number, number, number, number];

export interface RendererMemory {
  layerPages: number;
  compositePages: number;
  /** All GPU textures and buffers the renderer allocated. */
  bytes: number;
  /** Layer tiles on the GPU, and how many fit in the budget. */
  residentTiles: number;
  tileCapacity: number;
  /** Evicted layer tiles (compressed in JS memory) and their size. */
  compressedTiles: number;
  compressedBytes: number;
  /** Tiles being reloaded. */
  loadingTiles: number;
  /** Totals since start. */
  evictions: number;
  reloads: number;
}

/**
 * The narrow interface the app draws through.
 *
 * GPU model:
 *  - Layer tiles: atlas page textures of 256² tile slots, holding the most
 *    recently used tiles within the budget (see TileResidency); the rest are
 *    compressed in memory. Tiles are immutable once written; strokes and
 *    resizes write new tiles.
 *  - Stroke mask: coverage of the stroke in progress, in the coordinates of
 *    the canvas being drawn on (dabs use MAX blending), plus a prediction
 *    mask redrawn every frame.
 *  - Composite cache: a tile pyramid per canvas (see `PyramidPlanner`).
 *
 * Calls only queue work; `render()` runs it once per animation frame.
 * Tiles touched by dabs, predictions, merges and resizes are invalidated
 * automatically; anything else (layer properties, undo) is reported through
 * `invalidateTiles`.
 */
export interface Renderer {
  readonly kind: RendererKind;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null;
  /** Called when work becomes ready without any app change (e.g. a tile finished reloading). */
  onNeedsFrame: (() => void) | null;
  /**
   * A canvas's composite changes on this frame inside `dirty`, in canvas
   * pixels. Covers strokes in progress, merges, undo, layer changes, resizes
   * and changes inherited through arrows. Fires at most once per canvas per
   * frame (changes are merged), sources before their inheritors.
   */
  onCompositeChanged: ((canvasId: CanvasId, dirty: Rect) => void) | null;
  memory(): RendererMemory;
  /** Reload latencies (ms) since the last call. */
  takeReloadTimes(): number[];

  /** Follow the document's tiles (ids): freed tiles are dropped from the GPU and the backing store. */
  useTileStore(store: TileStore): void;

  /** Resize the canvas backing store (device pixels). */
  resize(pixelWidth: number, pixelHeight: number): void;

  /** All canvases, back to front. Call whenever any of them changes. */
  setCanvases(canvases: readonly CanvasRenderState[]): void;
  invalidateTiles(canvasId: CanvasId, keys: readonly TileKey[] | 'all'): void;
  /** Rectangles drawn above the canvases (selection, highlights; Phase 3 arrows). */
  setOverlay(shapes: readonly OverlayShape[]): void;
  /**
   * Phase 3: build a canvas's composite over `rect` (canvas px) at pyramid
   * `level` (0 = full resolution, each level halves it) in the next frame,
   * even if the canvas is off screen. Call before every render() that needs it.
   */
  requestComposite(canvasId: CanvasId, level: number, rect: Rect): void;
  /**
   * Phase 3: the canvas's composite over `rect` at `level` as it is now: the
   * tiles to sample, falling back to coarser tiles or paper where the
   * requested level isn't built yet. Valid until the next render().
   */
  compositeTiles(canvasId: CanvasId, level: number, rect: Rect): CompositeTile[];

  /** Clear the stroke mask for a new stroke on `canvasId` (dab coordinates are that canvas's pixels). */
  beginStroke(canvasId: CanvasId): void;
  addStrokeDabs(dabs: readonly Dab[]): void;
  /** Replace the temporary predicted dabs ([] clears them). */
  setPredictedDabs(dabs: readonly Dab[]): void;
  /** Write `src tile + stroke mask` (clipped to the canvas) into each job's `dst` slot. */
  mergeStroke(canvasId: CanvasId, jobs: readonly MergeJob[], style: StrokeStyle): void;
  /** Produce the new tiles of a resized canvas. */
  retile(canvasId: CanvasId, jobs: readonly RetileJob[]): void;

  /** Run queued work and draw the view. */
  render(view: ViewState): FrameInfo;

  /** The colour on screen at a device pixel (what the user sees). */
  readScreenPixel(x: number, y: number): Promise<Rgba8>;
  /** For each tile, whether it is completely transparent. */
  findEmptyTiles(tiles: readonly TileId[]): Promise<boolean[]>;
  /** A THUMBNAIL_SIZE² premultiplied RGBA image of a layer (tiles still reloading are left out). */
  readThumbnail(tiles: ReadonlyMap<TileKey, TileId>): Promise<Uint8Array>;

  destroy(): void;
}
