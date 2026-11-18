import type { Dab, StrokeStyle } from './renderer';

/**
 * Backend-independent bookkeeping shared by the WebGPU and WebGL2 renderers:
 * the ordered list of pending document/stroke operations, the active stroke
 * style and the current prediction. Each backend drains this in `render()`.
 */

export type RenderCommand =
  | { kind: 'clearStroke' }
  | { kind: 'dabs'; dabs: Dab[] }
  | { kind: 'mergeStroke'; style: StrokeStyle }
  | { kind: 'clearDocument' };

export class CommandQueue {
  private commands: RenderCommand[] = [];
  /** Style of the stroke currently shown in the stroke mask, or null when none. */
  activeStyle: StrokeStyle | null = null;
  predictedDabs: Dab[] = [];
  /** True when the prediction mask needs to be cleared/redrawn this frame. */
  predictionChanged = false;

  beginStroke(style: StrokeStyle): void {
    this.commands.push({ kind: 'clearStroke' });
    this.activeStyle = { color: [...style.color], opacity: style.opacity };
  }

  addDabs(dabs: readonly Dab[]): void {
    if (dabs.length === 0 || !this.activeStyle) return;
    const last = this.commands[this.commands.length - 1];
    if (last?.kind === 'dabs') last.dabs.push(...dabs);
    else this.commands.push({ kind: 'dabs', dabs: [...dabs] });
  }

  setPrediction(dabs: readonly Dab[]): void {
    if (dabs.length === 0 && this.predictedDabs.length === 0) return;
    this.predictedDabs = [...dabs];
    this.predictionChanged = true;
  }

  endStroke(): void {
    if (!this.activeStyle) return;
    this.commands.push({ kind: 'mergeStroke', style: this.activeStyle });
    this.activeStyle = null;
    this.setPrediction([]);
  }

  clearDocument(): void {
    this.commands.push({ kind: 'clearDocument' });
  }

  /** Take all pending commands, in order. */
  drain(): RenderCommand[] {
    const out = this.commands;
    this.commands = [];
    return out;
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

/** Fixed brush hardness for Phase 0: fraction of the radius that is fully opaque. */
export const DAB_HARDNESS = 0.8;
