import { LAYER_GPU_SLOTS, PINNED_PREVIEW_LEVEL, SLOTS_PER_PAGE, TILE_READBACKS_PER_FRAME, TILE_SIZE, UPLOADS_PER_FRAME } from '../config';
import type { TileStore } from '../document/tileStore';
import { DirtyTiles, slotLocation, tileCoords, type TileId, type TileKey, type TileSlot } from '../document/tiles';
import type { CanvasId } from '../document/paintDocument';
import { canvasTilesInRect, intersect, union, type Rect } from '../workspace/coords';
import { Propagation } from './propagation';
import { packCompositeUniforms, packLookup, paperRgba } from './compositePacking';
import { FrameQueue, type FrameOp, type Readback, type TileCopy } from './frameQueue';
import { levelForZoom, PyramidPlanner, type DisplayQuad, type DownsampleJob, type FramePlan, type PlannerCanvas } from './pyramid';
import { blockBounds, blockLevel, blockSourceRect, packBlockLookup, packBlockUniforms, stagingOrigin, STAGING_TILES } from './blockPacking';
import type { InheritedBlock } from '../document/inheritedBlock';
import { TileResidency, type Eviction } from './residency';
import { CompressedTileStore, type TileBackingStore } from './tileBackingStore';
import type { CanvasRenderState, FrameInfo, CompositeTile, Dab, MergeJob, OverlayQuad, OverlayRect, OverlayShape, RendererMemory, RetileJob, StrokeStyle, ViewState } from './renderer';

export interface Size {
  width: number;
  height: number;
}

/** Phase 4: one tile of a canvas's saved preview (pyramid `level`, tile `key` at that level, premultiplied RGBA). */
export interface PreviewTile {
  level: number;
  key: TileKey;
  rgba: Uint8Array;
}

/**
 * Backend-independent half of both renderers. It queues work, keeps the
 * canvases' render state, runs the pyramid planner, and packs everything the
 * GPU needs into flat instance arrays, so each backend only binds textures and
 * issues draws and copies.
 *
 * Positions on screen are computed here in double precision (workspace →
 * clip), so canvases far from the workspace origin stay exact even though
 * the GPU works in single precision.
 *
 * Documents name tiles by id; `residency` decides which ids are on the GPU.
 * Queued work runs in order, and waits (from frame to frame) until the tiles
 * it reads are back on the GPU. Composites of tiles that are still reloading
 * wait too; the planner shows a coarser preview meanwhile.
 */

/** Per-instance floats of each pass (see the shaders for the meaning). */
export const COMPOSITE_INSTANCE_FLOATS = 4; // dst x, y in the level-0 page · tile origin x, y in the canvas
export const DOWNSAMPLE_INSTANCE_FLOATS = 12; // dst x, y, size, level · src x, y, has src, src page · paper rgba (premultiplied)
export const TILE_QUAD_FLOATS = 16; // clip origin, x axis, y axis · texel rect · clamp rect · checker size, 0
export const SOLID_QUAD_FLOATS = 12; // clip origin, x axis, y axis · rgba · checker size, 0
/** Checkerboard square size (device px) under canvases whose paper is hidden. */
export const CHECKER_DEVICE_PX = 16;

export interface CompositeBatch {
  canvasId: CanvasId;
  /**
   * The canvas's compositor inputs: tile lookup in GPU slots (which can move
   * between frames) and, if it draws an inherited block, where to find each
   * part of the source's composite.
   */
  upload: { uniforms: Float32Array; lookup: Uint32Array; blockLookup: Uint32Array | null };
  /** Instances grouped by level-0 page (or staging tiles, see `staged`). */
  instances: Float32Array;
  runs: { page: number; first: number; count: number }[];
  /**
   * Set for canvases with an inherited block. They read composite pages, so
   * they can't render into one: instance i renders into staging tile i, and
   * is then copied to level-0 slot `staged[i]`. Runs are then one run on page 0.
   */
  staged: TileSlot[] | null;
}

/**
 * One depth of the inheritance graph: composite and downsample the canvases
 * at this depth, after the stages of their sources.
 */
export interface CompositeStage {
  depth: number;
  composites: CompositeBatch[];
  downsample: { instances: Float32Array; runs: { page: number; first: number; count: number }[] };
}

/** An inherited block the compositor draws this frame. */
interface ActiveBlock {
  block: InheritedBlock;
  sourceId: CanvasId;
  sourceSize: Size;
  /** The block's bounding box on the inheritor, null if off the canvas. */
  bounds: Rect | null;
}

export type DisplayRun =
  | { kind: 'tile'; pool: 'level0' | 'preview'; page: number; first: number; count: number }
  | { kind: 'solid'; first: number; count: number };

/**
 * Queued work that needs tiles on the GPU: ops, and readbacks of layer tiles.
 * (Reads for saving have their own queue: they don't need to wait in line.)
 */
type QueuedWork = FrameOp | Exclude<Readback, { kind: 'screenPixel' | 'tiles' }>;

export interface Frame {
  /** Slot-level ops, in order. */
  ops: FrameOp[];
  prediction: Dab[] | null;
  readbacks: Readback[];
  /** Per-canvas GPU resources to release. */
  removedCanvases: CanvasId[];
  /** Phase 4: saved preview tiles to write into preview-pool slots before anything else (an opened project). */
  previewUploads: { slot: TileSlot; rgba: Uint8Array }[];
  /** Composite work in dependency order: sources' stages before their inheritors'. */
  stages: CompositeStage[];
  display: { tiles: Float32Array; solids: Float32Array; runs: DisplayRun[] };
  stats: {
    composited: number;
    downsampled: number;
    visibleCanvases: number;
    /** Level-0 tiles of canvases with an inherited block composited this frame. */
    inheritorTiles: number;
    /** Inheritors that changed through an arrow this frame. */
    inheritorsUpdated: number;
    /** Inheritors with changes not yet shown (off screen during a stroke, or over budget). */
    staleInheritors: number;
    /** Deepest inheritance chain in the workspace. */
    maxDepth: number;
    /** Inheritors this frame brings fully up to date with their sources. */
    caughtUp: CaughtUp[];
  };
  moreWork: boolean;
}

/**
 * Merge jobs per queued op, at most. Each job reads one tile and writes one,
 * so a chunk is kept to a quarter of the GPU budget: it must fit on the GPU
 * together with the tiles being reloaded for it.
 */
const MAX_MERGE_CHUNK = 64;

/** Clip-space shadow offset of a canvas, in device pixels (right, down). */
const SHADOW_PX = 4;
const SHADOW_RGBA: [number, number, number, number] = [0, 0, 0, 0.35];

export class RenderCore {
  readonly queue = new FrameQueue();
  readonly planner: PyramidPlanner;
  readonly residency: TileResidency;
  /** See `Renderer.onCompositeChanged`. */
  onCompositeChanged: ((canvasId: CanvasId, dirty: Rect) => void) | null = null;
  private canvases: CanvasRenderState[] = [];
  private readonly byId = new Map<CanvasId, CanvasRenderState>();
  /** Work waiting for tiles to reload, oldest first. */
  private waiting: QueuedWork[] = [];
  /** New tiles whose pixels are queued but not written yet (they can't be composited yet). */
  private readonly unwritten = new Set<TileId>();
  /** Whether a tile id still has references (from the document's TileStore). */
  private isLive: (id: TileId) => boolean = () => true;
  private removed: CanvasId[] = [];
  private overlay: readonly OverlayShape[] = [];
  /** Arrows between canvases, and how changes flow down them. */
  private readonly propagation = new Propagation();
  /** Composite changes since the last frame, merged per canvas (sent once per frame). */
  private pendingChanges = new Map<CanvasId, Rect>();
  /** When the oldest of this frame's pending changes arrived (performance.now()). */
  private pendingSince: number | null = null;
  /**
   * Inheritors with changes from upstream not yet fully composited: when the
   * change that reached them first arrived. For the "change → end of chain"
   * measurement.
   */
  private chainPending = new Map<CanvasId, number>();
  /** Inheritors that changed through an arrow in the last frame (for the HUD). */
  inheritorsUpdated = 0;
  /** Preview reads for saving, answered after the next plan (see `readPreviewTiles`). */
  private previewReads: { canvasId: CanvasId; resolve: (tiles: PreviewTile[] | null) => void }[] = [];
  /** Saved previews of canvases not yet passed to setCanvases. */
  private readonly pendingSeeds = new Map<CanvasId, readonly PreviewTile[]>();
  /** Saved preview tiles waiting to be uploaded (see `seedPreviews`). */
  private previewUploads: { slot: TileSlot; rgba: Uint8Array }[] = [];
  /** Layer tiles to read back for saving, oldest first (see `readLayerTiles`). */
  private tileReads: { id: TileId; resolve: (rgba: Uint8Array | null) => void }[] = [];
  private strokeCanvas: CanvasId | null = null;
  /** Tiles the current stroke has touched: not plain paper even before the stroke is merged. */
  private readonly strokeTiles = new Set<TileKey>();

  /** `layerSlots`: the GPU budget for layer tiles, in tiles. */
  /** Where evicted layer tiles go (Phase 4: the project's store on disk). */
  useBackingStore(backing: TileBackingStore): void {
    this.residency.useBacking(backing);
  }

  static withLayerBudget(layerSlots: number): RenderCore {
    return new RenderCore(new PyramidPlanner(), new TileResidency(layerSlots, new CompressedTileStore()));
  }

  constructor(planner = new PyramidPlanner(), residency = new TileResidency(LAYER_GPU_SLOTS, new CompressedTileStore())) {
    this.planner = planner;
    this.residency = residency;
  }

  /** Residency numbers for RendererMemory. */
  tileMemory(): Omit<RendererMemory, 'layerPages' | 'compositePages' | 'bytes'> {
    const r = this.residency.stats();
    const c = this.residency.backingStats();
    return {
      residentTiles: r.resident,
      tileCapacity: r.capacity,
      compressedTiles: c.tiles,
      compressedBytes: c.bytes,
      loadingTiles: r.loading,
      evictions: r.evictions,
      reloads: r.reloads,
    };
  }

  /** Follow the document's tiles: freed tiles leave the GPU and the backing store. */
  useTileStore(store: TileStore): void {
    store.onFree((id) => this.residency.free(id));
    this.isLive = (id) => store.refCount(id) > 0;
  }

  // --- inputs -----------------------------------------------------------------

  setCanvases(canvases: readonly CanvasRenderState[]): void {
    const next = new Map(canvases.map((c) => [c.id, c]));
    for (const id of this.byId.keys()) if (!next.has(id)) this.removed.push(id);
    const previous = new Map(this.byId);
    this.canvases = [...canvases];
    this.byId.clear();
    for (const c of canvases) this.byId.set(c.id, c);
    this.propagation.setCanvases(
      canvases.map((c) => ({ id: c.id, size: { width: c.placement.width, height: c.placement.height }, inherited: c.inherited ?? null })),
    );
    // A new, changed or removed block changes the whole composite.
    for (const c of canvases) {
      const before = previous.get(c.id);
      if (before && (before.inherited ?? null) !== (c.inherited ?? null)) this.invalidate(c.id, 'all');
    }
    for (const [id, tiles] of this.pendingSeeds) if (this.byId.has(id)) this.seedPreviews(id, tiles);
  }

  canvas(id: CanvasId): CanvasRenderState | undefined {
    return this.byId.get(id);
  }

  invalidate(canvasId: CanvasId, keys: readonly TileKey[] | 'all'): void {
    const inside = keys === 'all' ? 'all' : this.insideCanvas(canvasId, keys);
    this.planner.invalidate(canvasId, inside);
    const c = this.byId.get(canvasId);
    const dirty = c ? dirtyRect(inside, c.placement) : null;
    if (!dirty) return;
    const pending = this.pendingChanges.get(canvasId);
    this.pendingChanges.set(canvasId, pending ? union([pending, dirty])! : dirty);
    this.pendingSince ??= performance.now();
  }

  /**
   * Send this frame's composite changes down the arrows: each inheritor
   * recomposites only the area its sources changed, and every changed canvas
   * reports one merged event, sources first.
   */
  private flushChanges(): void {
    this.inheritorsUpdated = 0;
    if (this.pendingChanges.size === 0) return;
    const changes = this.propagation.propagate(this.pendingChanges);
    const since = this.pendingSince ?? performance.now();
    this.pendingChanges = new Map();
    this.pendingSince = null;
    for (const change of changes) {
      if (change.inherited) {
        const c = this.byId.get(change.canvasId)!;
        this.planner.invalidate(change.canvasId, canvasTilesInRect(c.placement, change.rect));
        this.inheritorsUpdated++;
        this.chainPending.set(change.canvasId, Math.min(this.chainPending.get(change.canvasId) ?? Infinity, since));
      }
      this.onCompositeChanged?.(change.canvasId, change.rect);
    }
  }

  /**
   * Inheritors whose upstream changes are all composited by this frame's
   * work, with their chain depth and when the change arrived.
   */
  private takeCaughtUp(arrows: { depth(id: CanvasId): number }): CaughtUp[] {
    const done: CaughtUp[] = [];
    for (const [id, since] of this.chainPending) {
      const c = this.byId.get(id);
      if (c && this.planner.hasPendingChanges(id, wholeCanvas(c))) continue;
      this.chainPending.delete(id);
      if (c) done.push({ canvasId: id, depth: arrows.depth(id), since });
    }
    return done;
  }

  setOverlay(shapes: readonly OverlayShape[]): void {
    this.overlay = shapes;
  }

  requestComposite(canvasId: CanvasId, level: number, rect: Rect): void {
    this.planner.request(canvasId, level, rect);
  }

  compositeTiles(canvasId: CanvasId, level: number, rect: Rect): CompositeTile[] {
    return this.planner.tiledView(canvasId, level, rect).map((q): CompositeTile => {
      if (q.kind === 'paper') return { kind: 'paper', canvasRect: q.canvasRect, color: q.color };
      const { page, x, y } = slotLocation(q.slot);
      return { kind: 'tile', canvasRect: q.canvasRect, pool: q.pool, page, x, y, texels: q.texels };
    });
  }

  /**
   * The raw premultiplied RGBA of layer tiles, read back asynchronously, at
   * most TILE_READBACKS_PER_FRAME per frame. Null for a tile freed before it
   * was read. A tile is read once its pixels are written; a tile that is off
   * the GPU is reloaded first.
   */
  readLayerTiles(ids: readonly TileId[]): Promise<(Uint8Array | null)[]> {
    return Promise.all(ids.map((id) => new Promise<Uint8Array | null>((resolve) => this.tileReads.push({ id, resolve }))));
  }

  /** This frame's share of the tile reads, as one readback. Returns true if reads are left for later frames. */
  private takeTileReads(readbacks: Readback[]): boolean {
    const r = this.residency;
    const now: { slot: TileSlot; resolve: (rgba: Uint8Array | null) => void }[] = [];
    const later: typeof this.tileReads = [];
    for (const read of this.tileReads) {
      if (!this.isLive(read.id)) read.resolve(null);
      else if (now.length >= TILE_READBACKS_PER_FRAME || this.unwritten.has(read.id)) later.push(read);
      else if (r.ensure([read.id])) now.push({ slot: r.slotOf(read.id)!, resolve: read.resolve });
      else later.push(read); // reloading; the reload asks for a frame
    }
    this.tileReads = later;
    if (now.length > 0) {
      readbacks.push({
        kind: 'tiles',
        pool: 'layer',
        slots: now.map((n) => n.slot),
        resolve: (rgba) => now.forEach((n, i) => n.resolve(rgba[i]!)),
      });
    }
    return now.length > 0 && later.length > 0;
  }

  /**
   * Phase 4: the canvas's pinned preview tiles (levels 3–4 of its composite)
   * for saving, read back after the next frame's composites; null if they
   * aren't complete and up to date then (try again later).
   */
  readPreviewTiles(canvasId: CanvasId): Promise<PreviewTile[] | null> {
    return new Promise((resolve) => this.previewReads.push({ canvasId, resolve }));
  }

  /**
   * Phase 4: show an opened canvas from its saved preview tiles. Its cache
   * starts with these as complete pinned levels, and changes already queued
   * for it are dropped (they only said "everything is new"), so nothing has
   * to be composited, and no layer tile loaded, to show it zoomed out.
   * If `setCanvases` doesn't include the canvas yet, this happens when it
   * does. Returns false if the preview pool is full.
   */
  seedPreviews(canvasId: CanvasId, tiles: readonly PreviewTile[]): boolean {
    const c = this.byId.get(canvasId);
    if (!c) {
      this.pendingSeeds.set(canvasId, tiles); // applied when setCanvases brings the canvas
      return true;
    }
    this.pendingSeeds.delete(canvasId);
    const slots = this.planner.seed(canvasId, c.placement, paperRgba(c), tiles);
    if (!slots) return false;
    slots.forEach((slot, i) => this.previewUploads.push({ slot, rgba: tiles[i]!.rgba }));
    this.pendingChanges.delete(canvasId);
    this.chainPending.delete(canvasId);
    return true;
  }

  /** Answer this frame's preview reads (after the plan, so the frame's own updates are included). */
  private takePreviewReads(readbacks: Readback[]): void {
    for (const { canvasId, resolve } of this.previewReads) {
      const tiles = this.planner.pinnedTiles(canvasId);
      if (!tiles) {
        resolve(null);
        continue;
      }
      readbacks.push({
        kind: 'tiles',
        pool: 'preview',
        slots: tiles.map((t) => t.slot),
        resolve: (rgba) => resolve(tiles.map((t, i) => ({ level: t.level, key: t.key, rgba: rgba[i]! }))),
      });
    }
    this.previewReads = [];
  }

  beginStroke(canvasId: CanvasId): void {
    this.strokeCanvas = canvasId;
    this.strokeTiles.clear();
    this.queue.clearMask();
  }

  addDabs(dabs: readonly Dab[]): void {
    if (dabs.length === 0 || this.strokeCanvas === null) return;
    this.queue.addDabs(dabs);
    this.invalidateDabs(dabs);
  }

  setPrediction(dabs: readonly Dab[]): void {
    if (this.strokeCanvas !== null) this.invalidateDabs([...this.queue.currentPrediction, ...dabs]);
    this.queue.setPrediction(dabs);
  }

  merge(canvasId: CanvasId, jobs: readonly MergeJob[], style: StrokeStyle): void {
    const c = this.byId.get(canvasId);
    if (jobs.length === 0 || !c) return;
    // In chunks, so even a small GPU budget can hold everything one chunk reads and writes.
    const chunkSize = Math.max(1, Math.min(MAX_MERGE_CHUNK, Math.floor(this.residency.capacity / 4)));
    for (let i = 0; i < jobs.length; i += chunkSize) {
      const chunk = jobs.slice(i, i + chunkSize);
      this.queue.push({ kind: 'merge', jobs: chunk, style: { ...style }, canvas: { width: c.placement.width, height: c.placement.height } });
    }
    for (const j of jobs) this.unwritten.add(j.dst);
    this.invalidate(canvasId, jobs.map((j) => j.key));
  }

  retile(jobs: readonly RetileJob[]): void {
    for (const op of retileCopies(jobs)) this.queue.push(op);
    for (const j of jobs) this.unwritten.add(j.dst);
  }

  private invalidateDabs(dabs: readonly Dab[]): void {
    const dirty = new DirtyTiles();
    dirty.addDabs(dabs);
    for (const k of dirty.keys) this.strokeTiles.add(k);
    this.invalidate(this.strokeCanvas!, [...dirty.keys]);
  }

  /** Drop keys outside the canvas's tile grid (dabs near the edge reach past it). */
  private insideCanvas(canvasId: CanvasId, keys: readonly TileKey[]): TileKey[] {
    const c = this.byId.get(canvasId);
    if (!c) return [];
    const cols = Math.ceil(c.placement.width / TILE_SIZE);
    const rows = Math.ceil(c.placement.height / TILE_SIZE);
    return keys.filter((k) => {
      const { tx, ty } = tileCoords(k);
      return tx < cols && ty < rows;
    });
  }

  // --- one frame ----------------------------------------------------------------

  buildFrame(view: ViewState, clipPerDevicePx: [number, number]): Frame {
    this.flushChanges();
    const drained = this.queue.drain();
    const r = this.residency;
    r.beginFrame();
    const work: QueuedWork[] = [...this.waiting, ...drained.ops];
    const readbacks: Readback[] = [];
    for (const rb of drained.readbacks) {
      if (rb.kind === 'screenPixel' || rb.kind === 'tiles') readbacks.push(rb);
      else work.push(rb);
    }

    // Keep the tiles the oldest waiting work reads, then upload reloaded tiles.
    if (work[0]) r.ensure(this.reads(work[0]));
    const ops: FrameOp[] = [];
    for (const upload of r.takeUploads(UPLOADS_PER_FRAME)) {
      if (upload.evicted) ops.push(...evictOps(upload.evicted));
      ops.push({ kind: 'upload', slot: upload.slot, rgba: upload.rgba });
    }
    // Queued work, in order, as far as its tiles are on the GPU.
    let done = 0;
    let heldForRoom = false;
    for (const item of work) {
      const result = this.toSlots(item, ops, readbacks);
      heldForRoom = result === 'needsRoom';
      if (result !== 'done') break;
      done++;
    }
    this.waiting = work.slice(done);
    const moreTileReads = this.takeTileReads(readbacks);

    const viewLevel = levelForZoom(view.canvasPxPerDevicePx);
    const blocks = this.activeBlocks();
    const needs = this.requestBlockSources(blocks, view.visible, viewLevel);
    const arrows = this.propagation.arrows;
    // During a stroke, inheritors nobody can see wait (they are "stale") and catch up afterwards.
    const strokeInProgress = this.canvases.some((c) => c.liveStroke !== null);
    const plannerCanvases: PlannerCanvas[] = this.canvases.map((c) => {
      const block = blocks.get(c.id);
      const bounds = block?.bounds ?? null;
      /** An inheritor tile waits while the part of the source it shows still has changes to apply. */
      const sourceSettled = (key: TileKey): boolean => {
        const rect = block && blockSourceRect(block.block, block.sourceSize, tileRect(key));
        return !rect || !this.planner.hasPendingChanges(block.sourceId, rect);
      };
      return {
        id: c.id,
        placement: c.placement,
        paper: paperRgba(c),
        depth: arrows.depth(c.id),
        deferUpdates: strokeInProgress && block !== undefined && !needs.has(c.id),
        isPaperOnly: (key) =>
          !(bounds && intersect(tileRect(key), bounds)) &&
          c.sources.every((s) => !s.tiles.has(key)) &&
          !(c.liveStroke !== null && c.id === this.strokeCanvas && this.strokeTiles.has(key)),
        // Every layer tile under the key must be on the GPU (ensure() starts reloads).
        isReady: (key) => {
          const ids = tileIdsAt(c, key);
          return r.ensure(ids) && !ids.some((id) => this.unwritten.has(id)) && sourceSettled(key);
        },
      };
    });
    const plan = this.planner.plan(plannerCanvases, view.visible, viewLevel);
    const followUps = this.blockFollowUps(plan, blocks, needs);
    this.takePreviewReads(readbacks);
    const stages = this.packStages(plan, blocks, needs);
    for (const [id, keys] of followUps) this.invalidate(id, keys);
    const visibleCanvases = new Set(plan.display.map((q) => q.canvasId)).size;
    // Screen-pixel readbacks go last: they read the finished frame.
    readbacks.sort((a, b) => Number(a.kind === 'screenPixel') - Number(b.kind === 'screenPixel'));
    const frame: Frame = {
      ops,
      prediction: drained.prediction,
      readbacks,
      removedCanvases: this.removed,
      previewUploads: this.previewUploads,
      stages,
      display: this.packDisplay(plan.display, view, clipPerDevicePx),
      stats: {
        composited: plan.composites.length,
        downsampled: plan.downsamples.length,
        visibleCanvases,
        inheritorTiles: plan.composites.filter((j) => blocks.has(j.canvasId)).length,
        inheritorsUpdated: this.inheritorsUpdated,
        staleInheritors: [...blocks.keys()].filter((id) => this.planner.hasPendingChanges(id, wholeCanvas(this.byId.get(id)!))).length,
        maxDepth: Math.max(0, ...[...blocks.keys()].map((id) => arrows.depth(id))),
        caughtUp: this.takeCaughtUp(arrows),
      },
      // Budget-limited builds and reloaded tiles waiting for upload continue next frame.
      // (Work waiting for a reload doesn't spin: the reload asks for a frame when it lands.)
      moreWork: plan.overBudget || r.hasUploads || heldForRoom || followUps.size > 0 || moreTileReads,
    };
    this.removed = [];
    this.previewUploads = [];
    return frame;
  }

  // --- inherited blocks ---------------------------------------------------------

  /** Blocks to draw: linked, visible, and with their source in the workspace. */
  private activeBlocks(): Map<CanvasId, ActiveBlock> {
    const blocks = new Map<CanvasId, ActiveBlock>();
    for (const c of this.canvases) {
      const source = c.inherited?.source.kind === 'linked' ? this.byId.get(c.inherited.source.canvasId) : undefined;
      if (!c.inherited || !source) continue;
      const sourceSize = { width: source.placement.width, height: source.placement.height };
      blocks.set(c.id, {
        block: c.inherited,
        sourceId: source.id,
        sourceSize,
        bounds: blockBounds(c.inherited, sourceSize, { width: c.placement.width, height: c.placement.height }),
      });
    }
    return blocks;
  }

  /**
   * Which part of each canvas's composite is needed this frame, and at which
   * pyramid level: the visible part at the display level, plus whatever
   * visible inheritors show of it, through the whole upstream chain. The
   * sources' parts are requested from the planner, so they are built even
   * off screen, and kept (not evicted) while needed.
   */
  private requestBlockSources(blocks: ReadonlyMap<CanvasId, ActiveBlock>, visible: Rect, viewLevel: number): Map<CanvasId, BlockNeed> {
    const needs = new Map<CanvasId, BlockNeed>();
    for (const c of this.canvases) {
      const r = intersect(c.placement, visible);
      if (r) needs.set(c.id, { level: viewLevel, rect: { x: r.x - c.placement.x, y: r.y - c.placement.y, width: r.width, height: r.height } });
    }
    // Inheritors before their sources (deepest first), so a source has every need before passing its own up.
    const arrows = this.propagation.arrows;
    const order = [...blocks.keys()].sort((a, b) => arrows.depth(b) - arrows.depth(a));
    for (const id of order) {
      const need = needs.get(id);
      const b = blocks.get(id)!;
      const rect = need && blockSourceRect(b.block, b.sourceSize, need.rect);
      if (!need || !rect) continue;
      const level = sampleLevel(b, need);
      this.planner.request(b.sourceId, level, rect);
      const previous = needs.get(b.sourceId);
      needs.set(b.sourceId, previous ? { level: Math.min(previous.level, level), rect: union([previous.rect, rect])! } : { level, rect });
    }
    return needs;
  }

  /**
   * After planning: inheritor tiles composited from source tiles that are
   * still being brought up to date are composited again next frame (the
   * returned keys). Cached tiles composited at lower quality than their
   * level (because the inheritor was only needed at a coarser level) are
   * dropped, so they are rebuilt properly when needed.
   */
  private blockFollowUps(plan: FramePlan, blocks: ReadonlyMap<CanvasId, ActiveBlock>, needs: ReadonlyMap<CanvasId, BlockNeed>): Map<CanvasId, TileKey[]> {
    const again = new Map<CanvasId, TileKey[]>();
    for (const job of plan.composites) {
      const b = blocks.get(job.canvasId);
      if (!b) continue;
      const need = needs.get(job.canvasId);
      const rect = blockSourceRect(b.block, b.sourceSize, tileRect(job.key));
      if (rect && this.planner.willUpdate(b.sourceId, sampleLevel(b, need), rect)) {
        again.set(job.canvasId, [...(again.get(job.canvasId) ?? []), job.key]);
      }
      if (coarserBy(need) > 0 && !this.planner.isScratch(job.dst)) this.planner.forgetTile(job.canvasId, 0, job.key);
    }
    for (const d of plan.downsamples) {
      if (blocks.has(d.canvasId) && d.level < coarserBy(needs.get(d.canvasId))) this.planner.forgetTile(d.canvasId, d.level, d.key);
    }
    return again;
  }

  /** Group the plan's work into stages by graph depth and pack it for the GPU. */
  private packStages(plan: FramePlan, blocks: ReadonlyMap<CanvasId, ActiveBlock>, needs: ReadonlyMap<CanvasId, BlockNeed>): CompositeStage[] {
    const arrows = this.propagation.arrows;
    const stages = new Map<number, { composites: CompositeBatch[]; downs: DownsampleJob[] }>();
    const stage = (id: CanvasId) => {
      const depth = arrows.depth(id);
      let s = stages.get(depth);
      if (!s) stages.set(depth, (s = { composites: [], downs: [] }));
      return s;
    };

    const byCanvas = new Map<CanvasId, { key: TileKey; dst: TileSlot }[]>();
    for (const job of plan.composites) {
      const list = byCanvas.get(job.canvasId) ?? [];
      list.push(job);
      byCanvas.set(job.canvasId, list);
    }
    for (const [canvasId, jobs] of byCanvas) {
      const c = this.byId.get(canvasId)!;
      const b = blocks.get(canvasId);
      let blockUniforms: Float32Array | null = null;
      let blockLookup: Uint32Array | null = null;
      if (b) {
        const level = sampleLevel(b, needs.get(canvasId));
        blockUniforms = packBlockUniforms(b.block, b.sourceSize, level);
        blockLookup = packBlockLookup(this.compositeTiles(b.sourceId, level, { x: 0, y: 0, ...b.sourceSize }), level);
      }
      const upload = {
        uniforms: packCompositeUniforms(c, blockUniforms),
        lookup: packLookup(c, (id) => this.residency.slotOf(id)),
        blockLookup,
      };
      if (!b) {
        const sorted = [...jobs].sort((x, y) => x.dst - y.dst); // groups by page
        const instances = packCompositeInstances(sorted, (job) => slotLocation(job.dst));
        stage(canvasId).composites.push({ canvasId, upload, instances, runs: pageRuns(sorted.map((j) => j.dst)), staged: null });
        continue;
      }
      for (let i = 0; i < jobs.length; i += STAGING_TILES) {
        const chunk = jobs.slice(i, i + STAGING_TILES);
        const instances = packCompositeInstances(chunk, (_, n) => stagingOrigin(n));
        const staged = chunk.map((j) => j.dst);
        stage(canvasId).composites.push({ canvasId, upload, instances, runs: [{ page: 0, first: 0, count: chunk.length }], staged });
      }
    }
    for (const d of plan.downsamples) stage(d.canvasId).downs.push(d);

    return [...stages.entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, s]) => ({ depth, composites: s.composites, downsample: packDownsamples(s.downs) }));
  }

  /** Tile ids a piece of queued work reads. */
  private reads(item: QueuedWork): TileId[] {
    switch (item.kind) {
      case 'merge':
        return item.jobs.flatMap((j) => (j.src === null ? [] : [j.src]));
      case 'copies':
        return item.copies.map((c) => c.src);
      case 'empty':
        return item.slots;
      default:
        return [];
    }
  }

  /**
   * Translate one piece of queued work from tile ids to GPU slots, adding the
   * evictions that make room. If the tiles it reads aren't on the GPU yet
   * ('needsTiles': their reload will ask for a frame) or there is no room this
   * frame ('needsRoom'), it is retried next frame.
   */
  private toSlots(item: QueuedWork, ops: FrameOp[], readbacks: Readback[]): 'done' | 'needsTiles' | 'needsRoom' {
    const r = this.residency;
    if (item.kind === 'clearMask' || item.kind === 'dabs' || item.kind === 'evict' || item.kind === 'upload') {
      ops.push(item);
      return 'done';
    }
    if (item.kind === 'thumbnail') {
      // Thumbnails use what is on the GPU now, and ask for the rest to come back.
      r.ensure(item.tiles.map(([, id]) => id));
      const tiles = item.tiles.flatMap(([key, id]): [TileKey, TileSlot][] => {
        const slot = r.slotOf(id);
        return slot === undefined ? [] : [[key, slot]];
      });
      readbacks.push({ ...item, tiles });
      return 'done';
    }
    if (!r.ensure(this.reads(item))) return 'needsTiles';
    if (item.kind === 'empty') {
      // A tile the GPU has never seen counts as "not empty" (nothing is deleted by mistake).
      const known = item.slots.filter((id) => r.slotOf(id) !== undefined);
      readbacks.push({
        kind: 'empty',
        slots: known.map((id) => r.slotOf(id)!),
        resolve: (empty) => item.resolve(item.slots.map((id) => (known.includes(id) ? empty[known.indexOf(id)]! : false))),
      });
      return 'done';
    }

    // Writes: a slot for every new tile (skipping tiles freed while this waited).
    const evictions: FrameOp[] = [];
    const slotFor = new Map<TileId, TileSlot>();
    const writes = item.kind === 'merge' ? item.jobs.map((j) => j.dst) : item.zero;
    for (const id of writes) {
      if (!this.isLive(id)) continue;
      const placed = r.place(id);
      if (!placed) {
        ops.push(...evictions); // tiles already evicted for this work must still be read back
        return 'needsRoom'; // every slot is in use this frame
      }
      if (placed.evicted) evictions.push(...evictOps(placed.evicted));
      slotFor.set(id, placed.slot);
    }
    for (const id of writes) this.unwritten.delete(id);
    ops.push(...evictions);
    const src = (id: TileId): TileSlot => r.slotOf(id)!;
    if (item.kind === 'merge') {
      const jobs = item.jobs.flatMap((j) => {
        const dst = slotFor.get(j.dst);
        return dst === undefined ? [] : [{ key: j.key, src: j.src === null ? null : src(j.src), dst }];
      });
      if (jobs.length > 0) ops.push({ ...item, jobs });
    } else {
      const zero = item.zero.flatMap((id) => (slotFor.has(id) ? [slotFor.get(id)!] : []));
      const copies = item.copies.flatMap((c) => (slotFor.has(c.dst) ? [{ ...c, src: src(c.src), dst: slotFor.get(c.dst)! }] : []));
      if (zero.length > 0) ops.push({ kind: 'copies', zero, copies });
    }
    return 'done';
  }

  /** Display quads in draw order: the background grid; per canvas a shadow, then its tiles; then the overlay. */
  private packDisplay(quads: readonly DisplayQuad[], view: ViewState, clipPerPx: [number, number]): Frame['display'] {
    const m = view.workspaceToClip;
    const tiles: number[] = [];
    const solids: number[] = [];
    const runs: DisplayRun[] = [];
    /** `checker`: checkerboard square size in device px under the colour (0 = none). */
    const addSolid = (corners: ClipQuad, rgba: readonly number[], checker = 0): void => {
      const last = runs[runs.length - 1];
      if (last?.kind === 'solid') last.count++;
      else runs.push({ kind: 'solid', first: solids.length / SOLID_QUAD_FLOATS, count: 1 });
      solids.push(...corners, ...rgba, checker, 0);
    };
    for (const line of backgroundGrid(view.visible, view.canvasPxPerDevicePx)) addSolid(clipQuad(m, line.rect), line.color);
    let previousCanvas: CanvasId | null = null;
    for (const q of quads) {
      const c = this.byId.get(q.canvasId)!;
      if (q.canvasId !== previousCanvas) {
        previousCanvas = q.canvasId;
        const shadow = clipQuad(m, c.placement);
        shadow[0] += SHADOW_PX * clipPerPx[0];
        shadow[1] -= SHADOW_PX * clipPerPx[1];
        addSolid(shadow, SHADOW_RGBA);
      }
      const rect = { ...q.canvasRect, x: q.canvasRect.x + c.placement.x, y: q.canvasRect.y + c.placement.y };
      // A canvas with hidden paper is transparent: show a checkerboard through it.
      const checker = c.paperVisible === false ? CHECKER_DEVICE_PX : 0;
      if (q.kind === 'paper') {
        addSolid(clipQuad(m, rect), q.color, checker);
        continue;
      }
      const loc = slotLocation(q.slot);
      const last = runs[runs.length - 1];
      if (last?.kind === 'tile' && last.pool === q.pool && last.page === loc.page) last.count++;
      else runs.push({ kind: 'tile', pool: q.pool, page: loc.page, first: tiles.length / TILE_QUAD_FLOATS, count: 1 });
      tiles.push(
        ...clipQuad(m, rect),
        loc.x + q.texels.x, loc.y + q.texels.y, loc.x + q.texels.x + q.texels.width, loc.y + q.texels.y + q.texels.height,
        loc.x + 0.5, loc.y + 0.5, loc.x + TILE_SIZE - 0.5, loc.y + TILE_SIZE - 0.5,
        checker, 0,
      );
    }
    for (const o of this.overlay) addSolid('rect' in o ? clipQuad(m, o.rect) : clipParallelogram(m, o), o.color);
    return { tiles: new Float32Array(tiles), solids: new Float32Array(solids), runs };
  }
}

/** Which part of a canvas's composite is needed this frame (canvas px), at which pyramid level. */
interface BlockNeed {
  level: number;
  rect: Rect;
}

/**
 * How many levels coarser than full quality an inheritor's composites are
 * this frame: matching the level it is needed at, but never coarser than the
 * always-kept preview levels (so those are always built at full quality).
 * A canvas that nothing needs only builds those kept levels.
 */
function coarserBy(need: BlockNeed | undefined): number {
  return Math.min(need?.level ?? PINNED_PREVIEW_LEVEL, PINNED_PREVIEW_LEVEL);
}

/** The source level an inheritor samples this frame. */
function sampleLevel(b: ActiveBlock, need: BlockNeed | undefined): number {
  return blockLevel(b.block.placement.scale, coarserBy(need));
}

/** An inheritor brought up to date: its chain depth and when the change it shows first arrived. */
export interface CaughtUp {
  canvasId: CanvasId;
  depth: number;
  since: number;
}

/**
 * Inheritance numbers for a frame's FrameInfo. `submittedAt` is when the
 * frame's GPU work was submitted, which ends each propagation time.
 */
export function inheritanceInfo(stats: Frame['stats'], submittedAt: number): Pick<FrameInfo, 'inheritorsUpdated' | 'staleInheritors' | 'propagation'> {
  return {
    inheritorsUpdated: stats.inheritorsUpdated,
    staleInheritors: stats.staleInheritors,
    propagation: stats.caughtUp.map((c) => ({ depth: c.depth, ms: submittedAt - c.since })),
  };
}

/** A canvas's own pixels, as a rect. */
function wholeCanvas(c: CanvasRenderState): Rect {
  return { x: 0, y: 0, width: c.placement.width, height: c.placement.height };
}

/** Canvas-pixel rect of level-0 tile `key`. */
function tileRect(key: TileKey): Rect {
  const { tx, ty } = tileCoords(key);
  return { x: tx * TILE_SIZE, y: ty * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
}

/** Composite instances: where each tile is written, and its origin in the canvas. */
function packCompositeInstances<T extends { key: TileKey }>(jobs: readonly T[], target: (job: T, i: number) => { x: number; y: number }): Float32Array {
  const instances = new Float32Array(jobs.length * COMPOSITE_INSTANCE_FLOATS);
  jobs.forEach((job, i) => {
    const dst = target(job, i);
    const { tx, ty } = tileCoords(job.key);
    instances.set([dst.x, dst.y, tx * TILE_SIZE, ty * TILE_SIZE], i * COMPOSITE_INSTANCE_FLOATS);
  });
  return instances;
}

/** Downsample instances, grouped by destination preview page. */
function packDownsamples(jobs: readonly DownsampleJob[]): CompositeStage['downsample'] {
  const downs = [...jobs].sort((a, b) => a.dst - b.dst);
  const instances = new Float32Array(downs.length * DOWNSAMPLE_INSTANCE_FLOATS);
  downs.forEach((d, i) => {
    const dst = slotLocation(d.dst);
    const src = d.src === null ? null : slotLocation(d.src);
    instances.set(
      [dst.x + d.x, dst.y + d.y, d.size, d.level, src?.x ?? 0, src?.y ?? 0, src ? 1 : 0, src?.page ?? 0, ...d.paper],
      i * DOWNSAMPLE_INSTANCE_FLOATS,
    );
  });
  return { instances, runs: pageRuns(downs.map((d) => d.dst)) };
}

/** A parallelogram in clip space: origin, x axis, y axis. */
type ClipQuad = [number, number, number, number, number, number];

/** Map a workspace rect to clip space with a column-major 3×3 matrix (double precision). */
export function clipQuad(m: Float64Array, r: Rect): ClipQuad {
  const ox = m[0]! * r.x + m[3]! * r.y + m[6]!;
  const oy = m[1]! * r.x + m[4]! * r.y + m[7]!;
  return [ox, oy, m[0]! * r.width, m[1]! * r.width, m[3]! * r.height, m[4]! * r.height];
}

/** A workspace parallelogram (origin and two edge vectors) in clip space. */
export function clipParallelogram(m: Float64Array, q: OverlayQuad): ClipQuad {
  const ox = m[0]! * q.origin.x + m[3]! * q.origin.y + m[6]!;
  const oy = m[1]! * q.origin.x + m[4]! * q.origin.y + m[7]!;
  const axis = (v: { x: number; y: number }) => [m[0]! * v.x + m[3]! * v.y, m[1]! * v.x + m[4]! * v.y];
  return [ox, oy, ...axis(q.xAxis), ...axis(q.yAxis)] as ClipQuad;
}

/** Consecutive runs of slots on the same page (slots must be sorted). */
function pageRuns(slots: readonly TileSlot[]): { page: number; first: number; count: number }[] {
  const runs: { page: number; first: number; count: number }[] = [];
  slots.forEach((slot, i) => {
    const page = Math.floor(slot / SLOTS_PER_PAGE);
    const last = runs[runs.length - 1];
    if (last && last.page === page) last.count++;
    else runs.push({ page, first: i, count: 1 });
  });
  return runs;
}

/**
 * The canvas-pixel rectangle covering changed tiles, clipped to the canvas
 * ('all' = the whole canvas). Null if nothing changed.
 */
export function dirtyRect(keys: readonly TileKey[] | 'all', size: { width: number; height: number }): Rect | null {
  const canvas = { x: 0, y: 0, width: size.width, height: size.height };
  if (keys === 'all') return canvas;
  if (keys.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of keys) {
    const { tx, ty } = tileCoords(k);
    x0 = Math.min(x0, tx * TILE_SIZE);
    y0 = Math.min(y0, ty * TILE_SIZE);
    x1 = Math.max(x1, (tx + 1) * TILE_SIZE);
    y1 = Math.max(y1, (ty + 1) * TILE_SIZE);
  }
  return intersect(canvas, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** Grid spacing (workspace px) is TILE_SIZE × a power of two, at least this many device px apart. */
const GRID_MIN_DEVICE_PX = 48;
const GRID_RGBA: [number, number, number, number] = [0.035, 0.035, 0.035, 0.035]; // faint white, premultiplied

/**
 * Faint grid lines over the visible workspace, 1 device px wide, so empty
 * space reads as a surface and panning has visible motion. The spacing
 * doubles as you zoom out, so there are never more than a few dozen lines.
 */
export function backgroundGrid(visible: Rect, canvasPxPerDevicePx: number): OverlayRect[] {
  let spacing = TILE_SIZE;
  while (spacing / canvasPxPerDevicePx < GRID_MIN_DEVICE_PX) spacing *= 2;
  const width = canvasPxPerDevicePx;
  const lines: OverlayRect[] = [];
  for (let x = Math.ceil(visible.x / spacing) * spacing || 0; x <= visible.x + visible.width; x += spacing) {
    lines.push({ rect: { x, y: visible.y, width, height: visible.height }, color: GRID_RGBA });
  }
  for (let y = Math.ceil(visible.y / spacing) * spacing || 0; y <= visible.y + visible.height; y += spacing) {
    lines.push({ rect: { x: visible.x, y, width: visible.width, height: width }, color: GRID_RGBA });
  }
  return lines;
}

/** Layer tile ids of every visible source of a canvas at `key`. */
function tileIdsAt(c: CanvasRenderState, key: TileKey): TileId[] {
  const ids: TileId[] = [];
  for (const s of c.sources) {
    const id = s.tiles.get(key);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** The GPU work an eviction needs: a readback, unless the tile is already on disk. */
function evictOps(e: Eviction): FrameOp[] {
  return e.needsReadback ? [{ kind: 'evict', slot: e.slot, done: e.pixels }] : [];
}

/**
 * Turn resize jobs into plain tile copies, one op per new tile (so each can
 * wait for its own source tiles): zero the tile, then copy the part of every
 * source tile that lands inside the tile's `keep` region.
 */
export function retileCopies(jobs: readonly RetileJob[]): Extract<FrameOp, { kind: 'copies' }>[] {
  return jobs.map((job) => {
    const copies: TileCopy[] = [];
    for (const s of job.sources) {
      const placed: Rect = { x: s.dx, y: s.dy, width: TILE_SIZE, height: TILE_SIZE };
      const part = intersect(placed, job.keep);
      if (!part) continue;
      copies.push({ src: s.src, sx: part.x - s.dx, sy: part.y - s.dy, dst: job.dst, dx: part.x, dy: part.y, width: part.width, height: part.height });
    }
    return { kind: 'copies' as const, zero: [job.dst], copies };
  });
}
