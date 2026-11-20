import { describe, expect, it } from 'vitest';
import { snapPosition } from './snap';

const other = { x: 1000, y: 0, width: 500, height: 800 };
const at = (x: number, y: number) => ({ x, y, width: 400, height: 600 });

describe('snapPosition', () => {
  it('lines up with the edges of another canvas', () => {
    expect(snapPosition(at(1006, 7), [other], 10, null)).toEqual({ x: 1000, y: 0 }); // left to left, top to top
    expect(snapPosition(at(1103, 195), [other], 10, null)).toEqual({ x: 1100, y: 200 }); // right to right, bottom to bottom
  });

  it('sits side by side with another canvas', () => {
    expect(snapPosition(at(596, 300), [other], 10, null)).toEqual({ x: 600, y: 300 }); // our right on their left
    expect(snapPosition(at(1497, 300), [other], 10, null)).toEqual({ x: 1500, y: 300 }); // our left on their right
  });

  it('picks the nearest edge, and leaves positions far from everything alone', () => {
    expect(snapPosition(at(1004, 0), [other, { ...other, x: 1010 }], 10, null).x).toBe(1000);
    expect(snapPosition(at(300.4, 1234.6), [other], 10, null)).toEqual({ x: 300, y: 1235 });
  });

  it('falls back to the grid when no edge is close', () => {
    expect(snapPosition(at(212, -95), [], 20, 100)).toEqual({ x: 200, y: -100 });
    expect(snapPosition(at(250, 0), [], 20, 100).x).toBe(250);
  });
});
