import { describe, expect, it } from 'vitest';
import { edgeIndicator } from './undoIndicator';

describe('edgeIndicator', () => {
  const view = { w: 1000, h: 600 };
  const at = (x: number, y: number) => edgeIndicator({ x, y, width: 100, height: 100 }, view.w, view.h, 20);

  it('is null while any part of the canvas is on screen', () => {
    expect(at(450, 250)).toBeNull();
    expect(at(-90, -90)).toBeNull(); // just the corner visible
  });

  it('points right from the right edge', () => {
    expect(at(3000, 250)).toEqual({ x: 980, y: 300, angle: 0 });
  });

  it('points up from the top edge', () => {
    const p = at(450, -2000)!;
    expect(p.x).toBeCloseTo(500);
    expect(p.y).toBeCloseTo(20);
    expect(p.angle).toBeCloseTo(-Math.PI / 2);
  });

  it('stops at whichever edge the direction reaches first', () => {
    const p = at(-5000, 5000)!; // down-left
    expect(p.y).toBeCloseTo(580);
    expect(p.x).toBeGreaterThan(20);
    expect(p.x).toBeLessThan(500);
  });
});
