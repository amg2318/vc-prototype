import { describe, expect, it } from 'vitest';
import { DabInterpolator, MIN_SPACING_PX, dabSpacing, type Dab, type DabPoint } from './dabs';

const pt = (x: number, y = 0, radius = 10, opacity = 1): DabPoint => ({ x, y, radius, opacity });

function gaps(dabs: Dab[]): number[] {
  return dabs.slice(1).map((d, i) => Math.hypot(d.x - dabs[i]!.x, d.y - dabs[i]!.y));
}

describe('dabSpacing', () => {
  it('is a fraction of the diameter', () => {
    expect(dabSpacing(10, 0.15)).toBeCloseTo(3);
    expect(dabSpacing(50, 0.25)).toBeCloseTo(25);
  });

  it('never goes below the minimum spacing', () => {
    expect(dabSpacing(0.1, 0.1)).toBe(MIN_SPACING_PX);
    expect(dabSpacing(0, 0.1)).toBe(MIN_SPACING_PX);
  });
});

describe('DabInterpolator', () => {
  it('emits one dab at the start of a stroke', () => {
    const interp = new DabInterpolator(0.2);
    expect(interp.begin(pt(5, 6))).toEqual([pt(5, 6)]);
  });

  it('places dabs at a constant spacing along a straight line', () => {
    const interp = new DabInterpolator(0.2); // radius 10 → spacing 4
    const dabs = [...interp.begin(pt(0)), ...interp.addPoint(pt(100))];
    expect(dabs).toHaveLength(26); // 0, 4, …, 100
    for (const g of gaps(dabs)) expect(g).toBeCloseTo(4, 6);
  });

  it('gives the same dabs however the path is split into input points', () => {
    const whole = new DabInterpolator(0.15);
    const pieces = new DabInterpolator(0.15);
    const a = [...whole.begin(pt(0)), ...whole.addPoint(pt(90))];
    const b = [...pieces.begin(pt(0))];
    for (let x = 1.7; x < 90; x += 1.7) b.push(...pieces.addPoint(pt(x)));
    b.push(...pieces.addPoint(pt(90)));
    expect(b).toHaveLength(a.length);
    b.forEach((d, i) => expect(d.x).toBeCloseTo(a[i]!.x, 6));
  });

  it('carries leftover distance across short segments', () => {
    const interp = new DabInterpolator(0.25); // spacing 5
    interp.begin(pt(0));
    expect(interp.addPoint(pt(2))).toHaveLength(0);
    expect(interp.addPoint(pt(4))).toHaveLength(0);
    const dabs = interp.addPoint(pt(6));
    expect(dabs).toHaveLength(1);
    expect(dabs[0]!.x).toBeCloseTo(5);
  });

  it('spaces dabs closer as the radius shrinks', () => {
    const interp = new DabInterpolator(0.2);
    const dabs = [...interp.begin(pt(0, 0, 20)), ...interp.addPoint(pt(200, 0, 2))];
    const g = gaps(dabs);
    expect(g[0]!).toBeGreaterThan(g[g.length - 1]!);
    for (const d of dabs) {
      expect(d.radius).toBeLessThanOrEqual(20);
      expect(d.radius).toBeGreaterThanOrEqual(2);
    }
  });

  it('interpolates opacity along the segment', () => {
    const interp = new DabInterpolator(0.25);
    interp.begin(pt(0, 0, 10, 0));
    const dabs = interp.addPoint(pt(100, 0, 10, 1));
    const mid = dabs.find((d) => Math.abs(d.x - 50) < 1e-6)!;
    expect(mid.opacity).toBeCloseTo(0.5);
  });

  it('emits nothing for a zero-length segment', () => {
    const interp = new DabInterpolator(0.2);
    interp.begin(pt(3, 3));
    expect(interp.addPoint(pt(3, 3))).toEqual([]);
  });

  it('clone() continues identically without affecting the original', () => {
    const interp = new DabInterpolator(0.2);
    interp.begin(pt(0));
    interp.addPoint(pt(7));
    const copy = interp.clone();
    const fromCopy = copy.addPoint(pt(30));
    const fromOriginal = interp.addPoint(pt(30));
    expect(fromCopy).toEqual(fromOriginal);
  });
});
