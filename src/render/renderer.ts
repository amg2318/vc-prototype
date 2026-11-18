import type { Dab } from '../brush/dabs';
import type { BlendMode, RGB } from '../document/blend';
import type { MergeJob, StrokeMode } from '../document/editor';
import type { TileKey, TileSlot } from '../document/tiles';

export type { Dab, MergeJob };

export type RendererKind = 'webgpu' | 'webgl2';

export interface StrokeStyle {
  /** sRGB 0..1 (ignored when erasing). */
  color: RGB;
  /** Applied once to the whole stroke mask (no build-up within a stroke). */
  opacity: number;
  mode: StrokeMode;
}

/**
 * One entry in the compositor's layer stack. Phase 1 only has raster layers;
 * Phase 3 adds inherited blocks (a transformed, filtered image of another
 * canvas) as another `kind`, inserted at the bottom.
 */
export interface RasterSource {
  kind: 'raster';
  opacity: number;
  blendMode: BlendMode;
  tiles: ReadonlyMap<TileKey, TileSlot>;
}
export type CompositeSource = RasterSource;

export interface CompositeState {
  /** Non-erasable background colour, below every source. */
  paper: RGB;
  /** Visible sources, bottom to top. */
  sources: CompositeSource[];
  /** The stroke being drawn, shown on top of `sources[sourceIndex]` until it is merged. */
  liveStroke: { sourceIndex: number; style: StrokeStyle } | null;
}

export interface FrameInfo {
  /** performance.now() right after the frame's GPU work was submitted. */
  submittedAt: number;
  /** Resolves with performance.now() when the GPU has finished (WebGPU only). */
  gpuDone: Promise<number> | null;
  /** Tiles recomposited this frame. */
  compositedTiles: number;
  /** CPU time spent encoding the composite pass. */
  compositeCpuMs: number;
  /** GPU time of the composite pass in ms, when the device supports timestamp queries. */
  compositeGpuMs?: Promise<number>;
}

/** 0..255 per channel, premultiplied. */
export type Rgba8 = [number, number, number, number];

/**
 * The narrow interface the app draws through.
 *
 * GPU model:
 *  - Tile pool: atlas page textures, each holding many 256² tile slots. Tile
 *    slots are immutable once written; `mergeStroke` writes new slots.
 *  - Stroke mask: canvas-sized coverage of the stroke in progress (dabs use
 *    MAX blending so a stroke never builds up on itself), plus a prediction
 *    mask redrawn every frame.
 *  - Composite cache: canvas-sized image of paper + all sources. Only dirty
 *    tiles are recomposited, in one draw call.
 *
 * Calls only queue work. `render()` runs it once per animation frame, so GPU
 * work is batched no matter how many input events arrived. Tiles touched by
 * dabs, predictions and merges are marked dirty automatically; anything else
 * (layer property changes, undo) is reported through `invalidateTiles`.
 */
export interface Renderer {
  readonly kind: RendererKind;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null;
  /** Estimated GPU memory held by this renderer's textures. */
  gpuMemoryBytes(): number;
  /** Atlas pages currently allocated on the GPU. */
  readonly pageCount: number;

  /** Resize the canvas backing store (device pixels). */
  resize(pixelWidth: number, pixelHeight: number): void;

  /** Clear the stroke mask for a new stroke. */
  beginStroke(): void;
  addStrokeDabs(dabs: readonly Dab[]): void;
  /** Replace the temporary predicted dabs ([] clears them). */
  setPredictedDabs(dabs: readonly Dab[]): void;
  /** Write `src tile + stroke mask` into each job's `dst` slot. Allocates atlas pages as needed. */
  mergeStroke(jobs: readonly MergeJob[], style: StrokeStyle): void;

  setCompositeState(state: CompositeState): void;
  invalidateTiles(keys: readonly TileKey[] | 'all'): void;

  /**
   * Run queued work and draw the view.
   * @param docToClip column-major 3×3 matrix from viewport/docToClipMatrix
   * @param texelsPerPixel canvas pixels per device pixel (above 1 = zoomed out; used for filtering)
   */
  render(docToClip: Float32Array, texelsPerPixel: number): FrameInfo;

  /** The composited colour at a canvas pixel (paper + all visible layers). */
  readPixel(x: number, y: number): Promise<Rgba8>;
  /** For each slot, whether it is completely transparent. */
  findEmptyTiles(slots: readonly TileSlot[]): Promise<boolean[]>;
  /** A THUMBNAIL_SIZE² premultiplied RGBA image of a layer. */
  readThumbnail(tiles: ReadonlyMap<TileKey, TileSlot>): Promise<Uint8Array>;

  destroy(): void;
}
