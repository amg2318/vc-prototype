import { describe, expect, it } from 'vitest';
import { MAX_TAU_MS, Stabilizer, type StrokePoint } from './stabilizer';

const at = (x: number, time: number, pressure = 0.5): StrokePoint => ({ x, y: 0, pressure, time });

describe('Stabilizer', () => {
  it('passes samples through unchanged at amount 0', () => {
    const s = new Stabilizer(0);
    s.reset(at(0, 0));
    expect(s.push(at(10, 4))).toEqual(at(10, 4));
    expect(s.push(at(-3, 8, 0.9))).toEqual(at(-3, 8, 0.9));
  });

  it('moves a fraction 1 - exp(-dt/tau) toward the input', () => {
    const amount = 0.5;
    const s = new Stabilizer(amount);
    s.reset(at(0, 0));
    const out = s.push(at(100, 10));
    const expected = 100 * (1 - Math.exp(-10 / (amount * MAX_TAU_MS)));
    expect(out.x).toBeCloseTo(expected, 6);
  });

  it('smooths independently of sample rate (same elapsed time → same output)', () => {
    const slow = new Stabilizer(0.4);
    const fast = new Stabilizer(0.4);
    slow.reset(at(0, 0));
    fast.reset(at(0, 0));
    // A constant target, sampled at 60 Hz vs 240 Hz for the same duration.
    let slowOut = at(0, 0);
    let fastOut = at(0, 0);
    for (let t = 1; t <= 6; t++) slowOut = slow.push(at(50, t * (100 / 6)));
    for (let t = 1; t <= 24; t++) fastOut = fast.push(at(50, t * (100 / 24)));
    expect(fastOut.x).toBeCloseTo(slowOut.x, 6);
  });

  it('converges to a stationary input and never overshoots', () => {
    const s = new Stabilizer(1);
    s.reset(at(0, 0));
    let out = at(0, 0);
    for (let i = 1; i <= 200; i++) {
      out = s.push(at(10, i * 4));
      expect(out.x).toBeLessThanOrEqual(10);
    }
    expect(out.x).toBeCloseTo(10, 3);
  });

  it('uses a fallback dt for duplicate timestamps instead of stalling', () => {
    const s = new Stabilizer(0.5);
    s.reset(at(0, 5));
    expect(s.push(at(10, 5)).x).toBeGreaterThan(0);
  });

  it('finish() jumps to the last raw position and keeps smoothed pressure', () => {
    const s = new Stabilizer(0.8);
    s.reset(at(0, 0, 0.2));
    const smoothed = s.push(at(40, 8, 1));
    const tail = s.finish(at(40, 8, 1));
    expect(tail).not.toBeNull();
    expect(tail!.x).toBe(40);
    expect(tail!.pressure).toBeCloseTo(smoothed.pressure);
  });

  it('clone() does not share state', () => {
    const s = new Stabilizer(0.5);
    s.reset(at(0, 0));
    const copy = s.clone();
    copy.push(at(100, 10));
    expect(s.push(at(0, 10)).x).toBe(0);
  });
});
