import { describe, expect, it } from 'vitest';
import type { InputKind, PenSample } from '../input/penSample';
import { DEFAULT_BRUSH, type BrushSettings } from './brushSettings';
import { StrokeEngine, dabPointFor, rawPressure } from './strokeEngine';

function sample(x: number, time: number, pressure = 0.5, kind: InputKind = 'pen'): PenSample {
  return {
    x, y: 0, pressure, hasRealPressure: kind === 'pen', tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null,
    twist: 0, tangentialPressure: 0, timeStamp: time, kind, isEraser: false, isPredicted: false,
  };
}

const brush: BrushSettings = { ...DEFAULT_BRUSH, smoothing: 0, diameter: 20, spacing: 0.25 };

describe('rawPressure', () => {
  it('uses pen pressure, and full pressure for mouse and finger', () => {
    expect(rawPressure(sample(0, 0, 0.3, 'pen'), null, true)).toBe(0.3);
    expect(rawPressure(sample(0, 0, 0.5, 'mouse'), null, false)).toBe(1);
    expect(rawPressure(sample(0, 0, 0.2, 'touch'), null, false)).toBe(1);
  });

  it('can simulate pressure from speed: faster is lighter', () => {
    const previous = { x: 0, y: 0, pressure: 1, time: 0 };
    const at = (x: number) => rawPressure(sample(x, 10, 0.5, 'touch'), previous, true);
    expect(at(0)).toBe(1); // still
    expect(at(10)).toBeLessThan(1); // 1 px/ms
    expect(at(10)).toBeGreaterThan(at(20));
    expect(at(1000)).toBeCloseTo(0.25); // never thinner than the minimum
    expect(rawPressure(sample(1000, 10, 0.5, 'touch'), previous, false)).toBe(1); // setting off
  });
});

describe('dabPointFor', () => {
  it('scales radius and opacity between their minimums and full', () => {
    const p = (pressure: number) => dabPointFor({ x: 0, y: 0, pressure, time: 0 }, brush);
    expect(p(1).radius).toBeCloseTo(10);
    expect(p(1).opacity).toBeCloseTo(1);
    expect(p(0).radius).toBeCloseTo(10 * brush.minSizeFraction);
    expect(p(0).opacity).toBeCloseTo(brush.minOpacityFraction);
  });

  it('ignores pressure when the toggles are off', () => {
    const fixed = { ...brush, pressureAffectsSize: false, pressureAffectsOpacity: false };
    const d = dabPointFor({ x: 0, y: 0, pressure: 0.1, time: 0 }, fixed);
    expect(d.radius).toBe(10);
    expect(d.opacity).toBe(1);
  });
});

describe('StrokeEngine', () => {
  it('produces a dab at stroke start and more as the pen moves', () => {
    const engine = new StrokeEngine(brush);
    expect(engine.begin(sample(0, 0, 1), brush)).toHaveLength(1);
    expect(engine.add([sample(25, 4, 1), sample(50, 8, 1)]).length).toBeGreaterThan(5);
    expect(engine.active).toBe(true);
    engine.end();
    expect(engine.active).toBe(false);
  });

  it('prediction does not change the real stroke', () => {
    const a = new StrokeEngine(brush);
    const b = new StrokeEngine(brush);
    a.begin(sample(0, 0, 1), brush);
    b.begin(sample(0, 0, 1), brush);
    expect(a.predict([sample(80, 4, 1)]).length).toBeGreaterThan(0);
    expect(a.add([sample(20, 4, 1)])).toEqual(b.add([sample(20, 4, 1)]));
  });

  it('ignores samples when no stroke is active', () => {
    const engine = new StrokeEngine(brush);
    expect(engine.add([sample(10, 0)])).toEqual([]);
    expect(engine.predict([sample(10, 0)])).toEqual([]);
    expect(engine.end()).toEqual([]);
  });

  it('with smoothing, end() catches the stroke up to the pen position', () => {
    const smooth = { ...brush, smoothing: 1 };
    const engine = new StrokeEngine(smooth);
    engine.begin(sample(0, 0, 1), smooth);
    const during = engine.add([sample(100, 4, 1)]);
    const tail = engine.end();
    const lastDuring = during.length ? during[during.length - 1]!.x : 0;
    expect(lastDuring).toBeLessThan(50);
    expect(tail[tail.length - 1]!.x).toBeGreaterThan(95);
  });
});
