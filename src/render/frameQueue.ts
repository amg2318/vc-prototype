import type { Size } from './renderCore';
import type { Dab, MergeJob, Rgba8, StrokeStyle } from './renderer';
import type { TileKey, TileSlot } from '../document/tiles';

/**
 * The ordered GPU operations on layer tiles queued since the last frame,
 * the current prediction and pending readbacks. Drained once per frame.
 *
 * Queued ops name tiles by id; RenderCore turns them into the same ops on
 * GPU slots (adding evictions and reload uploads) before a backend runs them.
 */

/** Copy a region between tile slots (tile-local pixels). */
export interface TileCopy {
  src: TileSlot;
  sx: number;
  sy: number;
  dst: TileSlot;
  dx: number;
  dy: number;
  width: number;
  height: number;
}

export type FrameOp =
  | { kind: 'clearMask' }
  | { kind: 'dabs'; dabs: Dab[] }
  | { kind: 'merge'; jobs: MergeJob[]; style: StrokeStyle; canvas: Size }
  /** Zero `zero` slots, then run `copies` in order (resizing a canvas). */
  | { kind: 'copies'; zero: TileSlot[]; copies: TileCopy[] }
  /** Read a slot's pixels back before it is reused (slot level only). */
  | { kind: 'evict'; slot: TileSlot; done: (rgba: Uint8Array) => void }
  /** Write reloaded pixels into a slot (slot level only). */
  | { kind: 'upload'; slot: TileSlot; rgba: Uint8Array };

export type Readback =
  | { kind: 'screenPixel'; x: number; y: number; resolve: (rgba: Rgba8) => void }
  | { kind: 'empty'; slots: TileSlot[]; resolve: (empty: boolean[]) => void }
  | { kind: 'thumbnail'; tiles: [TileKey, TileSlot][]; resolve: (pixels: Uint8Array) => void }
  /** Raw RGBA of whole tiles in a pool's pages (layer tiles for saving; composite tiles for previews and export). */
  | { kind: 'tiles'; pool: TilePool; slots: TileSlot[]; resolve: (rgba: Uint8Array[]) => void };

/** The GPU tile pools: layer tiles, and the composite cache's full-resolution and preview pages. */
export type TilePool = 'layer' | 'level0' | 'preview';

export class FrameQueue {
  private ops: FrameOp[] = [];
  private readbacks: Readback[] = [];
  private prediction: Dab[] = [];
  private predictionChanged = false;

  get currentPrediction(): readonly Dab[] {
    return this.prediction;
  }

  clearMask(): void {
    this.ops.push({ kind: 'clearMask' });
  }

  addDabs(dabs: readonly Dab[]): void {
    if (dabs.length === 0) return;
    const last = this.ops[this.ops.length - 1];
    if (last?.kind === 'dabs') last.dabs.push(...dabs);
    else this.ops.push({ kind: 'dabs', dabs: [...dabs] });
  }

  setPrediction(dabs: readonly Dab[]): void {
    if (dabs.length === 0 && this.prediction.length === 0) return;
    this.prediction = [...dabs];
    this.predictionChanged = true;
  }

  push(op: FrameOp): void {
    this.ops.push(op);
  }

  addReadback(readback: Readback): void {
    this.readbacks.push(readback);
  }

  drain(): { ops: FrameOp[]; prediction: Dab[] | null; readbacks: Readback[] } {
    const frame = { ops: this.ops, prediction: this.predictionChanged ? this.prediction : null, readbacks: this.readbacks };
    this.ops = [];
    this.readbacks = [];
    this.predictionChanged = false;
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
