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

/** Speed (document px per ms) at which simulated pressure reaches its minimum. */
const SPEED_FOR_LIGHTEST = 4;
const LIGHTEST_SIMULATED_PRESSURE = 0.25;

/**
 * The pressure a sample draws with. Pens use what they report. Mice and
 * fingers have no real pressure: they draw at full pressure, or, with
 * `fromSpeed`, lighter the faster they move (the stabilizer smooths it).
 * Speed is measured in document px, so at low zoom the same hand speed
 * draws thinner.
 */
export function rawPressure(sample: PenSample, previous: StrokePoint | null, fromSpeed: boolean): number {
  if (sample.hasRealPressure) return sample.pressure;
  if (!fromSpeed || !previous) return 1;
  const dt = Math.max(1, sample.timeStamp - previous.time);
  const speed = Math.hypot(sample.x - previous.x, sample.y - previous.y) / dt;
  return Math.max(LIGHTEST_SIMULATED_PRESSURE, 1 - (speed / SPEED_FOR_LIGHTEST) * (1 - LIGHTEST_SIMULATED_PRESSURE));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dabPointFor(p: StrokePoint, brush: BrushSettings): DabPoint {
  const curved = evaluatePressureCurve(PRESSURE_CURVE_PRESETS[brush.pressureCurve], p.pressure);
  const sizeFactor = brush.pressureAffectsSize ? lerp(brush.minSizeFraction, 1, curved) : 1;
  const opacityPressure = Math.min(1, curved / brush.fullOpacityPressure);
  const opacity = brush.pressureAffectsOpacity ? lerp(brush.minOpacityFraction, 1, opacityPressure) : 1;
  return { x: p.x, y: p.y, radius: (brush.diameter / 2) * sizeFactor, opacity };
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
    const raw = this.toStrokePoint(sample, null);
    this.lastRaw = raw;
    return this.interpolator.begin(dabPointFor(this.stabilizer.reset(raw), this.brush));
  }

  /** Add real (coalesced) samples, in order. */
  add(samples: readonly PenSample[]): Dab[] {
    if (!this.lastRaw) return [];
    const dabs: Dab[] = [];
    for (const s of samples) {
      const raw = this.toStrokePoint(s, this.lastRaw);
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
    let previous = this.lastRaw;
    for (const s of samples) {
      const raw = this.toStrokePoint(s, previous);
      previous = raw;
      const smoothed = stabilizer.push(raw);
      dabs.push(...interpolator.addPoint(dabPointFor(smoothed, this.brush)));
    }
    return dabs;
  }

  private toStrokePoint(s: PenSample, previous: StrokePoint | null): StrokePoint {
    return { x: s.x, y: s.y, pressure: rawPressure(s, previous, this.brush.pressureFromSpeed), time: s.timeStamp };
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
