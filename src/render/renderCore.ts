import { SLOTS_PER_PAGE, TILE_SIZE } from '../config';
import { DirtyTiles, slotLocation, tileCoords, type TileKey, type TileSlot } from '../document/tiles';
import type { CanvasId } from '../document/paintDocument';
import { intersect, type Rect } from '../workspace/coords';
import { packCompositeUniforms, packLookup } from './compositePacking';
import { FrameQueue, type FrameOp, type Readback, type TileCopy } from './frameQueue';
import { levelForZoom, PyramidPlanner, type DisplayQuad, type PlannerCanvas } from './pyramid';
import type { CanvasRenderState, Dab, MergeJob, OverlayRect, RetileJob, StrokeStyle, ViewState } from './renderer';

export interface Size {
  width: number;
  height: number;
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
 */

/** Per-instance floats of each pass (see the shaders for the meaning). */
export const COMPOSITE_INSTANCE_FLOATS = 4; // dst x, y in the level-0 page · tile origin x, y in the canvas
export const DOWNSAMPLE_INSTANCE_FLOATS = 12; // dst x, y, size, level · src x, y, has src, src page · paper rgb, 0
export const TILE_QUAD_FLOATS = 16; // clip origin, x axis, y axis · texel rect · clamp rect · 0, 0
export const SOLID_QUAD_FLOATS = 12; // clip origin, x axis, y axis · rgba · 0, 0

export interface CompositeBatch {
  canvasId: CanvasId;
  /** Present when the canvas's sources or properties changed since its last upload. */
  upload: { uniforms: Float32Array; lookup: Uint32Array } | null;
  /** Instances grouped by level-0 page. */
  instances: Float32Array;
  runs: { page: number; first: number; count: number }[];
}

export type DisplayRun =
  | { kind: 'tile'; pool: 'level0' | 'preview'; page: number; first: number; count: number }
  | { kind: 'solid'; first: number; count: number };

export interface Frame {
  ops: FrameOp[];
  prediction: Dab[] | null;
  readbacks: Readback[];
  /** Per-canvas GPU resources to release. */
  removedCanvases: CanvasId[];
  composites: CompositeBatch[];
  downsample: { instances: Float32Array; runs: { page: number; first: number; count: number }[] };
  display: { tiles: Float32Array; solids: Float32Array; runs: DisplayRun[] };
  stats: { composited: number; downsampled: number; visibleCanvases: number };
}

/** Clip-space shadow offset of a canvas, in device pixels (right, down). */
const SHADOW_PX = 4;
const SHADOW_RGBA: [number, number, number, number] = [0, 0, 0, 0.35];

export class RenderCore {
  readonly queue = new FrameQueue();
  readonly planner: PyramidPlanner;
  private canvases: CanvasRenderState[] = [];
  private readonly byId = new Map<CanvasId, CanvasRenderState>();
  /** Canvases whose compositor uniforms/lookup must be uploaded before their next composite. */
  private readonly needsUpload = new Set<CanvasId>();
  private removed: CanvasId[] = [];
  private overlay: readonly OverlayRect[] = [];
  private strokeCanvas: CanvasId | null = null;
  /** Tiles the current stroke has touched: not plain paper even before the stroke is merged. */
  private readonly strokeTiles = new Set<TileKey>();

  constructor(planner = new PyramidPlanner()) {
    this.planner = planner;
  }

  // --- inputs -----------------------------------------------------------------

  setCanvases(canvases: readonly CanvasRenderState[]): void {
    const next = new Map(canvases.map((c) => [c.id, c]));
    for (const id of this.byId.keys()) if (!next.has(id)) this.removed.push(id);
    this.canvases = [...canvases];
    this.byId.clear();
    for (const c of canvases) {
      this.byId.set(c.id, c);
      this.needsUpload.add(c.id);
    }
  }

  canvas(id: CanvasId): CanvasRenderState | undefined {
    return this.byId.get(id);
  }

  invalidate(canvasId: CanvasId, keys: readonly TileKey[] | 'all'): void {
    this.planner.invalidate(canvasId, keys === 'all' ? 'all' : this.insideCanvas(canvasId, keys));
  }

  setOverlay(rects: readonly OverlayRect[]): void {
    this.overlay = rects;
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
    this.queue.push({ kind: 'merge', jobs: [...jobs], style: { ...style }, canvas: { width: c.placement.width, height: c.placement.height } });
    this.invalidate(canvasId, jobs.map((j) => j.key));
  }

  retile(jobs: readonly RetileJob[]): void {
    if (jobs.length > 0) this.queue.push(retileCopies(jobs));
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
    const drained = this.queue.drain();
    const plannerCanvases: PlannerCanvas[] = this.canvases.map((c) => ({
      id: c.id,
      placement: c.placement,
      paper: c.paper,
      isPaperOnly: (key) =>
        c.sources.every((s) => !s.tiles.has(key)) && !(c.liveStroke !== null && c.id === this.strokeCanvas && this.strokeTiles.has(key)),
      isReady: () => true, // tile residency (eviction) comes later
    }));
    const plan = this.planner.plan(plannerCanvases, view.visible, levelForZoom(view.canvasPxPerDevicePx));

    // Level-0 composites, one batch per canvas.
    const byCanvas = new Map<CanvasId, { key: TileKey; dst: TileSlot }[]>();
    for (const job of plan.composites) {
      const list = byCanvas.get(job.canvasId) ?? [];
      list.push(job);
      byCanvas.set(job.canvasId, list);
    }
    const composites: CompositeBatch[] = [];
    for (const [canvasId, jobs] of byCanvas) {
      const c = this.byId.get(canvasId)!;
      const upload = this.needsUpload.has(canvasId) ? { uniforms: packCompositeUniforms(c), lookup: packLookup(c) } : null;
      this.needsUpload.delete(canvasId);
      const sorted = [...jobs].sort((a, b) => a.dst - b.dst); // groups by page
      const instances = new Float32Array(sorted.length * COMPOSITE_INSTANCE_FLOATS);
      sorted.forEach((job, i) => {
        const dst = slotLocation(job.dst);
        const { tx, ty } = tileCoords(job.key);
        instances.set([dst.x, dst.y, tx * TILE_SIZE, ty * TILE_SIZE], i * COMPOSITE_INSTANCE_FLOATS);
      });
      composites.push({ canvasId, upload, instances, runs: pageRuns(sorted.map((j) => j.dst)) });
    }

    // Downsamples, grouped by destination preview page.
    const downs = [...plan.downsamples].sort((a, b) => a.dst - b.dst);
    const downInstances = new Float32Array(downs.length * DOWNSAMPLE_INSTANCE_FLOATS);
    downs.forEach((d, i) => {
      const dst = slotLocation(d.dst);
      const src = d.src === null ? null : slotLocation(d.src);
      downInstances.set(
        [dst.x + d.x, dst.y + d.y, d.size, d.level, src?.x ?? 0, src?.y ?? 0, src ? 1 : 0, src?.page ?? 0, ...d.paper, 0],
        i * DOWNSAMPLE_INSTANCE_FLOATS,
      );
    });

    const visibleCanvases = new Set(plan.display.map((q) => q.canvasId)).size;
    const frame: Frame = {
      ops: drained.ops,
      prediction: drained.prediction,
      readbacks: drained.readbacks,
      removedCanvases: this.removed,
      composites,
      downsample: { instances: downInstances, runs: pageRuns(downs.map((d) => d.dst)) },
      display: this.packDisplay(plan.display, view.workspaceToClip, clipPerDevicePx),
      stats: { composited: plan.composites.length, downsampled: plan.downsamples.length, visibleCanvases },
    };
    this.removed = [];
    return frame;
  }

  /** Display quads in draw order: per canvas a shadow, then its tiles; then the overlay. */
  private packDisplay(quads: readonly DisplayQuad[], m: Float64Array, clipPerPx: [number, number]): Frame['display'] {
    const tiles: number[] = [];
    const solids: number[] = [];
    const runs: DisplayRun[] = [];
    const addSolid = (corners: ClipQuad, rgba: readonly number[]): void => {
      const last = runs[runs.length - 1];
      if (last?.kind === 'solid') last.count++;
      else runs.push({ kind: 'solid', first: solids.length / SOLID_QUAD_FLOATS, count: 1 });
      solids.push(...corners, ...rgba, 0, 0);
    };
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
      if (q.kind === 'paper') {
        addSolid(clipQuad(m, rect), [...q.color, 1]);
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
        0, 0,
      );
    }
    for (const o of this.overlay) addSolid(clipQuad(m, o.rect), o.color);
    return { tiles: new Float32Array(tiles), solids: new Float32Array(solids), runs };
  }
}

/** A parallelogram in clip space: origin, x axis, y axis. */
type ClipQuad = [number, number, number, number, number, number];

/** Map a workspace rect to clip space with a column-major 3×3 matrix (double precision). */
export function clipQuad(m: Float64Array, r: Rect): ClipQuad {
  const ox = m[0]! * r.x + m[3]! * r.y + m[6]!;
  const oy = m[1]! * r.x + m[4]! * r.y + m[7]!;
  return [ox, oy, m[0]! * r.width, m[1]! * r.width, m[3]! * r.height, m[4]! * r.height];
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
 * Turn resize jobs into plain tile copies: zero each new tile, then copy the
 * part of every source tile that lands inside the tile's `keep` region.
 */
export function retileCopies(jobs: readonly RetileJob[]): Extract<FrameOp, { kind: 'copies' }> {
  const copies: TileCopy[] = [];
  for (const job of jobs) {
    for (const s of job.sources) {
      const placed: Rect = { x: s.dx, y: s.dy, width: TILE_SIZE, height: TILE_SIZE };
      const part = intersect(placed, job.keep);
      if (!part) continue;
      copies.push({ src: s.src, sx: part.x - s.dx, sy: part.y - s.dy, dst: job.dst, dx: part.x, dy: part.y, width: part.width, height: part.height });
    }
  }
  return { kind: 'copies', zero: jobs.map((j) => j.dst), copies };
}
