import type { Dab } from '../brush/dabs';
import type { BlendMode, RGB } from '../document/blend';
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
  /** Visible sources, bottom to top. */
  sources: CompositeSource[];
  /** The stroke being drawn on this canvas, shown on `sources[sourceIndex]` until merged. */
  liveStroke: { sourceIndex: number; style: StrokeStyle } | null;
}

/** A flat-coloured rectangle in workspace coordinates (premultiplied RGBA), drawn above all canvases. */
export interface OverlayRect {
  rect: Rect;
  color: [number, number, number, number];
}

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
  setOverlay(rects: readonly OverlayRect[]): void;

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
