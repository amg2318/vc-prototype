import { describe, expect, it } from 'vitest';
import { planResize, retileLayer } from './retile';
import { tileKey } from './tiles';

const old = { x: 0, y: 0, width: 1000, height: 1000 };
/** A full 4 × 4 grid of tiles (the last row/column is partly outside the 1000 px canvas). */
function fullLayer(): Map<number, number> {
  const tiles = new Map<number, number>();
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) tiles.set(tileKey(tx, ty), ty * 4 + tx);
  return tiles;
}

describe('planResize', () => {
  it('keeps content in place in the workspace around the anchor', () => {
    expect(planResize(old, 2000, 1000, { x: 0, y: 0 })).toEqual({
      placement: { x: 0, y: 0, width: 2000, height: 1000 }, offsetX: 0, offsetY: 0,
    });
    expect(planResize(old, 1200, 800, { x: 0.5, y: 1 })).toEqual({
      placement: { x: -100, y: 200, width: 1200, height: 800 }, offsetX: 100, offsetY: -200,
    });
  });
});

describe('retileLayer', () => {
  it('extending from the top-left reuses every tile', () => {
    const r = retileLayer(fullLayer(), old, planResize(old, 2000, 2000, { x: 0, y: 0 }));
    expect(r.jobs).toEqual([]);
    expect(r.reused).toEqual(fullLayer());
  });

  it('cropping clips edge tiles and drops tiles outside', () => {
    const r = retileLayer(fullLayer(), old, planResize(old, 600, 1000, { x: 0, y: 0 }));
    // Columns 0–1 stay as they are; column 2 (512–768) is cut at 600; column 3 is gone.
    expect([...r.reused.keys()].map((k) => k % 16).every((tx) => tx < 2)).toBe(true);
    expect(r.jobs.map((j) => j.key).sort((a, b) => a - b)).toEqual([2, 18, 34, 50]);
    expect(r.jobs[0]!.keep).toEqual({ x: 0, y: 0, width: 88, height: 256 });
    expect(r.jobs[0]!.sources).toEqual([{ src: 2, dx: 0, dy: 0 }]);
  });

  it('a tile-aligned shift moves tiles to new keys without GPU work', () => {
    const r = retileLayer(fullLayer(), old, planResize(old, 1512, 1000, { x: 1, y: 0 }));
    expect(r.jobs).toEqual([]);
    expect(r.reused.get(tileKey(2, 0))).toBe(0); // old (0,0) now two tiles to the right
    expect(r.reused.size).toBe(16);
  });

  it('an unaligned shift redraws every tile from up to four old tiles', () => {
    const single = new Map([[tileKey(0, 0), 7]]);
    const r = retileLayer(single, old, planResize(old, 1100, 1100, { x: 1, y: 1 })); // shift by (100, 100)
    expect(r.reused.size).toBe(0);
    const byKey = new Map(r.jobs.map((j) => [j.key, j]));
    expect([...byKey.keys()].sort((a, b) => a - b)).toEqual([tileKey(0, 0), tileKey(1, 0), tileKey(0, 1), tileKey(1, 1)]);
    expect(byKey.get(tileKey(0, 0))!.sources).toEqual([{ src: 7, dx: 100, dy: 100 }]);
    expect(byKey.get(tileKey(1, 1))!.sources).toEqual([{ src: 7, dx: -156, dy: -156 }]);
    const full = retileLayer(fullLayer(), old, planResize(old, 1100, 1100, { x: 1, y: 1 }));
    expect(Math.max(...full.jobs.map((j) => j.sources.length))).toBe(4);
  });

  it('drops an empty layer to nothing', () => {
    expect(retileLayer(new Map(), old, planResize(old, 500, 500, { x: 0.5, y: 0.5 }))).toEqual({ reused: new Map(), jobs: [] });
  });
});
