import { describe, expect, it } from 'vitest';
import { PRESSURE_CURVE_PRESETS, evaluatePressureCurve, type PressureCurvePreset } from './pressureCurve';

const presets = Object.keys(PRESSURE_CURVE_PRESETS) as PressureCurvePreset[];

describe('evaluatePressureCurve', () => {
  it('linear preset is the identity', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      expect(evaluatePressureCurve(PRESSURE_CURVE_PRESETS.linear, x)).toBeCloseTo(x, 5);
    }
  });

  it.each(presets)('%s maps 0 → 0 and 1 → 1 and is monotonic', (name) => {
    const curve = PRESSURE_CURVE_PRESETS[name];
    expect(evaluatePressureCurve(curve, 0)).toBe(0);
    expect(evaluatePressureCurve(curve, 1)).toBe(1);
    let previous = 0;
    for (let i = 1; i <= 100; i++) {
      const y = evaluatePressureCurve(curve, i / 100);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it('clamps out-of-range and NaN input', () => {
    const curve = PRESSURE_CURVE_PRESETS.soft;
    expect(evaluatePressureCurve(curve, -0.5)).toBe(0);
    expect(evaluatePressureCurve(curve, 1.5)).toBe(1);
    expect(evaluatePressureCurve(curve, Number.NaN)).toBe(0);
  });

  it('soft responds more than linear to light pressure; firm responds less', () => {
    const light = 0.25;
    expect(evaluatePressureCurve(PRESSURE_CURVE_PRESETS.soft, light)).toBeGreaterThan(light);
    expect(evaluatePressureCurve(PRESSURE_CURVE_PRESETS.firm, light)).toBeLessThan(light);
  });
});
