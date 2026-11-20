import type { PressureCurvePreset } from './pressureCurve';

export interface BrushSettings {
  /** Maximum dab diameter in document pixels (reached at full effective pressure). */
  diameter: number;
  /** Stroke opacity 0..1, applied once when the stroke is composited (no build-up). */
  opacity: number;
  /** Dab spacing as a fraction of the dab diameter. */
  spacing: number;
  pressureCurve: PressureCurvePreset;
  pressureAffectsSize: boolean;
  pressureAffectsOpacity: boolean;
  /** Diameter at zero pressure, as a fraction of `diameter`. */
  minSizeFraction: number;
  /** Dab opacity at zero pressure, as a fraction of full. */
  minOpacityFraction: number;
  /**
   * Effective pressure (after the curve) at which opacity reaches full, 0..1.
   * 1: only the hardest press is fully opaque. Lower: a lighter press is enough.
   */
  fullOpacityPressure: number;
  /** Stabilizer amount 0..1. */
  smoothing: number;
  /**
   * For input without real pressure (mouse, finger): fake it from speed,
   * faster = thinner. Off: such input draws at full pressure.
   */
  pressureFromSpeed: boolean;
  /** sRGB, 0..1 per channel. */
  color: [number, number, number];
}

export const DEFAULT_BRUSH: BrushSettings = {
  diameter: 24,
  opacity: 1,
  spacing: 0.15,
  pressureCurve: 'linear',
  pressureAffectsSize: true,
  pressureAffectsOpacity: true,
  minSizeFraction: 0.05,
  minOpacityFraction: 0.15,
  fullOpacityPressure: 1,
  smoothing: 0.15,
  pressureFromSpeed: false,
  color: [0.08, 0.08, 0.1],
};
