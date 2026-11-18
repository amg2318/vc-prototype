import type { PenSample } from '../input/penSample';
import type { BrushSettings } from './brushSettings';
import { DabInterpolator, type Dab, type DabPoint } from './dabs';
import { PRESSURE_CURVE_PRESETS, evaluatePressureCurve } from './pressureCurve';
import { Stabilizer, type StrokePoint } from './stabilizer';

/**
 * Turns PenSamples into dabs for one stroke at a time:
 *
 *   PenSample → raw pressure → stabilizer → pressure curve → size/opacity → dab interpolation
 *
 * Pure logic (no DOM, no GPU), so it can be unit-tested and later reused for
 * stroke replay (undo, re-rendering tiles) without changes.
 */

/** Mice report a constant 0.5 while pressed; treat the mouse as full pressure. */
export function rawPressure(sample: PenSample): number {
  return sample.pointerType === 'mouse' ? 1 : sample.pressure;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dabPointFor(p: StrokePoint, brush: BrushSettings): DabPoint {
  const curved = evaluatePressureCurve(PRESSURE_CURVE_PRESETS[brush.pressureCurve], p.pressure);
  const sizeFactor = brush.pressureAffectsSize ? lerp(brush.minSizeFraction, 1, curved) : 1;
  const opacity = brush.pressureAffectsOpacity ? lerp(brush.minOpacityFraction, 1, curved) : 1;
  return { x: p.x, y: p.y, radius: (brush.diameter / 2) * sizeFactor, opacity };
}

function toStrokePoint(s: PenSample): StrokePoint {
  return { x: s.x, y: s.y, pressure: rawPressure(s), time: s.timeStamp };
}

export class StrokeEngine {
  private stabilizer: Stabilizer;
  private interpolator: DabInterpolator;
  private lastRaw: StrokePoint | null = null;
  private brush: BrushSettings;

  constructor(brush: BrushSettings) {
    this.brush = { ...brush };
    this.stabilizer = new Stabilizer(brush.smoothing);
    this.interpolator = new DabInterpolator(brush.spacing);
  }

  get active(): boolean {
    return this.lastRaw !== null;
  }

  /** Brush settings are captured at stroke start so a stroke stays consistent. */
  begin(sample: PenSample, brush: BrushSettings): Dab[] {
    this.brush = { ...brush };
    this.stabilizer = new Stabilizer(brush.smoothing);
    this.interpolator = new DabInterpolator(brush.spacing);
    const raw = toStrokePoint(sample);
    this.lastRaw = raw;
    return this.interpolator.begin(dabPointFor(this.stabilizer.reset(raw), this.brush));
  }

  /** Add real (coalesced) samples, in order. */
  add(samples: readonly PenSample[]): Dab[] {
    if (!this.lastRaw) return [];
    const dabs: Dab[] = [];
    for (const s of samples) {
      const raw = toStrokePoint(s);
      this.lastRaw = raw;
      const smoothed = this.stabilizer.push(raw);
      dabs.push(...this.interpolator.addPoint(dabPointFor(smoothed, this.brush)));
    }
    return dabs;
  }

  /**
   * Dabs for predicted samples, computed on copies of the stabilizer and
   * interpolator so the real stroke state is untouched. The caller draws them
   * temporarily and replaces them on the next frame.
   */
  predict(samples: readonly PenSample[]): Dab[] {
    if (!this.lastRaw || samples.length === 0) return [];
    const stabilizer = this.stabilizer.clone();
    const interpolator = this.interpolator.clone();
    const dabs: Dab[] = [];
    for (const s of samples) {
      const smoothed = stabilizer.push(toStrokePoint(s));
      dabs.push(...interpolator.addPoint(dabPointFor(smoothed, this.brush)));
    }
    return dabs;
  }

  /** Finish the stroke; returns any final dabs (the stabilizer catching up to the pen). */
  end(): Dab[] {
    const lastRaw = this.lastRaw;
    this.lastRaw = null;
    if (!lastRaw) return [];
    const tail = this.stabilizer.finish(lastRaw);
    return tail ? this.interpolator.addPoint(dabPointFor(tail, this.brush)) : [];
  }
}
