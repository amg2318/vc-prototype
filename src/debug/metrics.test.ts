import { describe, expect, it } from 'vitest';
import type { PenSample } from '../input/penSample';
import { Metrics, computeStats, percentile, plausibleLatency, rateFromTimestamps, rateOfTotal } from './metrics';

const sample = (timeStamp: number): PenSample => ({
  x: 0, y: 0, pressure: 0.5, hasRealPressure: true, tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null, twist: 0,
  tangentialPressure: 0, timeStamp, kind: 'pen', isEraser: false, isPredicted: false,
});

describe('statistics helpers', () => {
  it('percentile uses nearest-rank', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it('computeStats ignores nulls', () => {
    const s = computeStats([4, null, 2, 6]);
    expect(s).toEqual({ count: 3, mean: 4, p50: 4, p95: 6, max: 6 });
  });

  it('rateFromTimestamps needs a minimum span', () => {
    expect(rateFromTimestamps([0, 50])).toBeNull();
    const t = Array.from({ length: 241 }, (_, i) => i * (1000 / 240));
    expect(rateFromTimestamps(t)).toBeCloseTo(240, 6);
  });

  it('plausibleLatency discards negative and huge values', () => {
    expect(plausibleLatency(100, 112)).toBe(12);
    expect(plausibleLatency(100, 90)).toBeNull();
    expect(plausibleLatency(0, 5000)).toBeNull();
  });
});

describe('Metrics', () => {
  it('attributes pending input to the next frame and measures latency to submit', () => {
    const m = new Metrics();
    m.noteInput([sample(100), sample(104)], 104);
    m.noteDabs(10, 3);
    m.frameRendered(110, 1.5, { submittedAt: 112, gpuDone: null, compositedTiles: 0, downsampledTiles: 0, visibleCanvases: 1, compositeCpuMs: 0, moreWork: false });
    const f = m.frames[0]!;
    expect(f.samples).toBe(2);
    expect(f.events).toBe(1);
    expect(f.inputToSubmitMs).toBe(8);
    expect(f.oldestInputToSubmitMs).toBe(12);
    expect(f.dabs).toBe(10);
  });

  it('only counts frame intervals between consecutive frames', () => {
    const m = new Metrics();
    const info = { submittedAt: 0, gpuDone: null, compositedTiles: 0, downsampledTiles: 0, visibleCanvases: 1, compositeCpuMs: 0, moreWork: false };
    m.frameRendered(0, 1, info);
    m.frameRendered(16, 1, info);
    m.frameRendered(2000, 1, info); // after idle
    expect(m.frames.map((f) => f.intervalMs)).toEqual([null, 16, null]);
    expect(m.summary(-Infinity, 2000).fps).toBeCloseTo(62.5);
  });

  it('fills GPU-done latency when the promise resolves', async () => {
    const m = new Metrics();
    m.noteInput([sample(100)], 100);
    m.frameRendered(105, 1, { submittedAt: 106, gpuDone: Promise.resolve(120), compositedTiles: 1, downsampledTiles: 0, visibleCanvases: 1, compositeCpuMs: 0, moreWork: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(m.frames[0]!.inputToGpuDoneMs).toBe(20);
  });

  it('counts implausible timestamps instead of recording them', () => {
    const m = new Metrics();
    m.noteInput([sample(5000)], 5000);
    m.frameRendered(10, 1, { submittedAt: 11, gpuDone: null, compositedTiles: 0, downsampledTiles: 0, visibleCanvases: 1, compositeCpuMs: 0, moreWork: false });
    expect(m.frames[0]!.inputToSubmitMs).toBeNull();
    expect(m.counters.implausibleTimestamps).toBe(1);
  });
});

describe('rateOfTotal', () => {
  it('measures a running total per second over the last second', () => {
    const points = [
      { t: 0, total: 0 },
      { t: 500, total: 100 },
      { t: 1000, total: 150 },
      { t: 1500, total: 250 },
    ];
    expect(rateOfTotal(points, 1500)).toBeCloseTo(150); // (250 - 100) over 1 s
  });

  it('is null without two points in the window', () => {
    expect(rateOfTotal([{ t: 0, total: 5 }], 0)).toBeNull();
    expect(rateOfTotal([{ t: 0, total: 0 }, { t: 100, total: 9 }], 5000)).toBeNull();
  });
});
