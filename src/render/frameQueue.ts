import { TILE_COUNT } from '../config';
import { DirtyTiles, type TileKey, type TileSlot } from '../document/tiles';
import type { CompositeState, Dab, MergeJob, Rgba8, StrokeStyle } from './renderer';

/**
 * Backend-independent bookkeeping shared by the WebGPU and WebGL2 renderers:
 * the ordered GPU operations queued since the last frame, the current
 * prediction, the dirty tiles of the composite and pending readbacks.
 * Each backend drains this once per frame in `render()`.
 */

export type FrameOp =
  | { kind: 'clearMask' }
  | { kind: 'dabs'; dabs: Dab[] }
  | { kind: 'merge'; jobs: MergeJob[]; style: StrokeStyle };

export type Readback =
  | { kind: 'pixel'; x: number; y: number; resolve: (rgba: Rgba8) => void }
  | { kind: 'empty'; slots: TileSlot[]; resolve: (empty: boolean[]) => void }
  | { kind: 'thumbnail'; tiles: [TileKey, TileSlot][]; resolve: (pixels: Uint8Array) => void };

export interface DrainedFrame {
  ops: FrameOp[];
  /** Predicted dabs to redraw, or null if the prediction is unchanged. */
  prediction: Dab[] | null;
  /** Tiles to recomposite. */
  dirty: TileKey[];
  /** Composite state, or null if unchanged since the last frame. */
  state: CompositeState | null;
  readbacks: Readback[];
}

export class FrameQueue {
  private ops: FrameOp[] = [];
  private readbacks: Readback[] = [];
  private prediction: Dab[] = [];
  private predictionChanged = false;
  private readonly dirty = new DirtyTiles();
  private allDirty = true; // first frame composites everything
  private state: CompositeState = { paper: [1, 1, 1], sources: [], liveStroke: null };
  private stateChanged = true;

  get compositeState(): CompositeState {
    return this.state;
  }

  clearMask(): void {
    this.ops.push({ kind: 'clearMask' });
  }

  addDabs(dabs: readonly Dab[]): void {
    if (dabs.length === 0) return;
    this.dirty.addDabs(dabs);
    const last = this.ops[this.ops.length - 1];
    if (last?.kind === 'dabs') last.dabs.push(...dabs);
    else this.ops.push({ kind: 'dabs', dabs: [...dabs] });
  }

  setPrediction(dabs: readonly Dab[]): void {
    if (dabs.length === 0 && this.prediction.length === 0) return;
    this.dirty.addDabs(this.prediction); // where the old prediction was
    this.dirty.addDabs(dabs);
    this.prediction = [...dabs];
    this.predictionChanged = true;
  }

  merge(jobs: readonly MergeJob[], style: StrokeStyle): void {
    if (jobs.length === 0) return;
    this.dirty.addAll(jobs.map((j) => j.key));
    this.ops.push({ kind: 'merge', jobs: [...jobs], style: { ...style } });
  }

  setState(state: CompositeState): void {
    this.state = state;
    this.stateChanged = true;
  }

  invalidate(keys: readonly TileKey[] | 'all'): void {
    if (keys === 'all') this.allDirty = true;
    else this.dirty.addAll(keys);
  }

  addReadback(readback: Readback): void {
    this.readbacks.push(readback);
  }

  /** True if render() would do anything. */
  get hasWork(): boolean {
    return (
      this.ops.length > 0 || this.readbacks.length > 0 || this.predictionChanged || this.allDirty || this.dirty.size > 0
    );
  }

  drain(): DrainedFrame {
    const frame: DrainedFrame = {
      ops: this.ops,
      prediction: this.predictionChanged ? this.prediction : null,
      dirty: this.allDirty ? Array.from({ length: TILE_COUNT }, (_, i) => i) : [...this.dirty.keys],
      state: this.stateChanged ? this.state : null,
      readbacks: this.readbacks,
    };
    this.ops = [];
    this.readbacks = [];
    this.predictionChanged = false;
    this.dirty.clear();
    this.allDirty = false;
    this.stateChanged = false;
    return frame;
  }
}

/** Floats per dab in instance buffers: x, y, radius, opacity. */
export const DAB_FLOATS = 4;

export function packDabs(dabs: readonly Dab[], target: Float32Array, offsetDabs: number): void {
  let i = offsetDabs * DAB_FLOATS;
  for (const d of dabs) {
    target[i++] = d.x;
    target[i++] = d.y;
    target[i++] = d.radius;
    target[i++] = d.opacity;
  }
}

/** Fixed brush hardness: fraction of the radius that is fully opaque. */
export const DAB_HARDNESS = 0.8;

/** Grow-only Float32Array scratch buffer. */
export function ensureCapacity(buffer: Float32Array<ArrayBuffer>, floats: number): Float32Array<ArrayBuffer> {
  if (buffer.length >= floats) return buffer;
  return new Float32Array(2 ** Math.ceil(Math.log2(Math.max(16, floats))));
}
