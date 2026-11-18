/**
 * Pressure curve: maps raw stylus pressure (0..1) to an effective pressure
 * (0..1) that then drives brush size and opacity.
 *
 * The curve is a cubic Bézier from (0,0) to (1,1) with two control points,
 * the same shape as a CSS `cubic-bezier()` easing. Two control points are
 * enough to express "soft", "firm" and S-shaped responses, and the same
 * representation can back a draggable curve editor later.
 */

export interface PressureCurve {
  /** Control point 1. x values must lie in [0, 1] so the curve is a function of x. */
  x1: number;
  y1: number;
  /** Control point 2. */
  x2: number;
  y2: number;
}

export const PRESSURE_CURVE_PRESETS = {
  /** Output = input. */
  linear: { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 },
  /** Light touches already give a strong response. */
  soft: { x1: 0.1, y1: 0.45, x2: 0.4, y2: 0.95 },
  /** Needs more force before the brush gets big/dark. */
  firm: { x1: 0.55, y1: 0.05, x2: 0.9, y2: 0.55 },
  /** Gentle at both ends, fast change in the middle. */
  sCurve: { x1: 0.45, y1: 0.0, x2: 0.55, y2: 1.0 },
} satisfies Record<string, PressureCurve>;

export type PressureCurvePreset = keyof typeof PRESSURE_CURVE_PRESETS;

function bezier1D(t: number, p1: number, p2: number): number {
  // Endpoints fixed at 0 and 1.
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/**
 * Evaluate the curve at input pressure `x` (clamped to 0..1).
 * Solves x(t) = x by bisection (x(t) is monotonic when x1, x2 ∈ [0, 1]),
 * then returns y(t). 24 iterations give ~1e-7 precision, far below 8-bit output.
 */
export function evaluatePressureCurve(curve: PressureCurve, x: number): number {
  if (!(x > 0)) return 0; // also maps NaN to 0
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezier1D(mid, curve.x1, curve.x2) < x) lo = mid;
    else hi = mid;
  }
  const y = bezier1D((lo + hi) / 2, curve.y1, curve.y2);
  return Math.min(1, Math.max(0, y));
}
