import { describe, expect, it } from 'vitest';
import type { PenSample } from '../input/penSample';
import { DEFAULT_BRUSH, type BrushSettings } from './brushSettings';
import { StrokeEngine, dabPointFor, rawPressure } from './strokeEngine';

function sample(x: number, time: number, pressure = 0.5, pointerType = 'pen'): PenSample {
  return {
    x, y: 0, pressure, tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null, twist: 0,
    tangentialPressure: 0, timeStamp: time, pointerType, isEraser: false, isPredicted: false,
  };
}

const brush: BrushSettings = { ...DEFAULT_BRUSH, smoothing: 0, diameter: 20, spacing: 0.25 };

describe('rawPressure', () => {
  it('treats the mouse as full pressure', () => {
    expect(rawPressure(sample(0, 0, 0.5, 'mouse'))).toBe(1);
    expect(rawPressure(sample(0, 0, 0.3, 'pen'))).toBe(0.3);
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
