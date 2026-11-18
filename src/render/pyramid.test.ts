import { describe, expect, it } from 'vitest';
import { PINNED_PREVIEW_LEVEL } from '../config';
import { tileKey, type TileKey } from '../document/tiles';
import { levelForZoom, levelTilesInRect, PyramidPlanner, type PlannerCanvas } from './pyramid';

function canvas(id: string, x: number, width: number, height: number, painted: TileKey[] = [], ready = () => true): PlannerCanvas {
  const set = new Set(painted);
  return {
    id,
    placement: { x, y: 0, width, height },
    paper: [1, 1, 1],
    isPaperOnly: (k) => !set.has(k),
    isReady: ready,
  };
}

const everywhere = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };
const nowhere = { x: 1e7, y: 1e7, width: 10, height: 10 };

/** Plan frames until nothing more gets built. */
function settle(p: PyramidPlanner, canvases: PlannerCanvas[], visible = everywhere, level = 0, maxFrames = 50) {
  for (let i = 0; i < maxFrames; i++) {
    const plan = p.plan(canvases, visible, level);
    if (plan.composites.length === 0 && plan.downsamples.length === 0) return plan;
  }
  throw new Error('did not settle');
}

describe('levels', () => {
  it('picks the level from the zoom', () => {
    expect([0.5, 1, 1.3, 1.5, 3, 6, 100].map(levelForZoom)).toEqual([0, 0, 0, 1, 2, 3, 4]);
  });

  it('lists level tiles over a canvas', () => {
    const a4 = { width: 2480, height: 3508 };
    const full = { x: 0, y: 0, ...a4 };
    expect(levelTilesInRect(a4, full, 0)).toHaveLength(10 * 14);
    expect(levelTilesInRect(a4, full, 3)).toEqual([tileKey(0, 0), tileKey(1, 0), tileKey(0, 1), tileKey(1, 1)]);
    expect(levelTilesInRect(a4, full, 4)).toEqual([tileKey(0, 0)]);
  });
});

describe('PyramidPlanner', () => {
  it('builds the pinned previews of a blank canvas without compositing anything', () => {
    const p = new PyramidPlanner(64, 64, 8);
    const plan = p.plan([canvas('a', 0, 1024, 1024)], nowhere, 0);
    expect(plan.composites).toEqual([]);
    // 16 level-0 tiles of paper go into one level-3 and one level-4 tile.
    expect(plan.downsamples).toHaveLength(32);
    expect(plan.downsamples.every((d) => d.src === null)).toBe(true);
    expect(p.isComplete('a', PINNED_PREVIEW_LEVEL, 0)).toBe(true);
    expect(plan.display).toEqual([]); // off screen
  });

  it('shows a canvas from its preview immediately, and full resolution once built', () => {
    const p = new PyramidPlanner(64, 64, 4);
    const painted = Array.from({ length: 16 }, (_, i) => tileKey(i % 4, Math.floor(i / 4)));
    const c = canvas('a', 0, 1024, 1024, painted);
    const first = p.plan([c], everywhere, 0);
    // Only 4 composites per frame: the first frame can't show everything at full resolution…
    expect(first.display).toHaveLength(16);
    expect(first.display.some((q) => q.kind === 'tile' && q.pool === 'level0')).toBe(true);
    // …and never shows anything blank: the rest is paper (no preview is ready yet).
    expect(first.display.every((q) => q.kind === 'tile' || q.kind === 'paper')).toBe(true);
    const done = settle(p, [c]);
    expect(done.display.every((q) => q.kind === 'tile' && q.pool === 'level0')).toBe(true);
  });

  it('uses the coarser previews while full-resolution tiles are missing', () => {
    const p = new PyramidPlanner(64, 64, 4);
    const c = canvas('a', 0, 1024, 1024, [0, 1, 2, 3, 16, 17]);
    settle(p, [c], nowhere); // pinned previews only
    const plan = p.plan([c], everywhere, 0);
    const fallback = plan.display.filter((q) => q.kind === 'tile' && q.pool === 'preview');
    expect(fallback.length).toBeGreaterThan(0);
    const q = fallback[0]!;
    if (q.kind !== 'tile') throw new Error();
    expect(q.texels.width).toBe(256 / 2 ** PINNED_PREVIEW_LEVEL); // a 256 px tile is 32 texels at level 3
  });

  it('updates only the changed region of every cached level', () => {
    const p = new PyramidPlanner(64, 64, 8);
    const c = canvas('a', 0, 1024, 1024, [tileKey(1, 0)]);
    settle(p, [c], everywhere, 1); // level 1 on screen, plus pinned 3 and 4
    p.invalidate('a', [tileKey(1, 0)]);
    const plan = p.plan([c], everywhere, 1);
    expect(plan.composites).toHaveLength(1); // one scratch composite of tile 5
    expect(plan.downsamples.map((d) => d.level).sort()).toEqual([1, 3, 4]);
    const l1 = plan.downsamples.find((d) => d.level === 1)!;
    expect([l1.x, l1.y, l1.size]).toEqual([128, 0, 128]); // tile (1,0) is the top-right quadrant of level-1 tile (0,0)
    expect(plan.downsamples.every((d) => d.src === plan.composites[0]!.dst)).toBe(true);
  });

  it('recomposites a visible full-resolution tile every frame it changes, without a budget', () => {
    const p = new PyramidPlanner(64, 64, 1);
    const c = canvas('a', 0, 1024, 1024, [0, 1, 2]);
    settle(p, [c]);
    p.invalidate('a', [0, 1, 2]);
    const plan = p.plan([c], everywhere, 0);
    expect(plan.composites.map((j) => j.key).sort()).toEqual([0, 1, 2]);
  });

  it('updates the pinned preview of an off-screen canvas', () => {
    const p = new PyramidPlanner(64, 64, 8);
    const a = canvas('a', 0, 512, 512, [0]);
    const b = canvas('b', 5000, 512, 512);
    settle(p, [a, b], { x: 5000, y: 0, width: 512, height: 512 });
    p.invalidate('a', [0]);
    const plan = p.plan([a, b], { x: 5000, y: 0, width: 512, height: 512 }, 0);
    expect(plan.composites).toEqual([expect.objectContaining({ canvasId: 'a', key: 0 })]);
    expect(plan.downsamples.map((d) => d.level).sort()).toEqual([3, 4]);
  });

  it('waits for tiles that are not on the GPU yet', () => {
    let ready = false;
    const p = new PyramidPlanner(64, 64, 8);
    const c = canvas('a', 0, 512, 512, [0], () => ready);
    const plan = p.plan([c], everywhere, 0);
    expect(plan.composites).toEqual([]);
    expect(plan.display[0]!.kind).toBe('paper');
    ready = true;
    const later = settle(p, [c]);
    expect(later.display.every((q) => q.kind === 'tile')).toBe(true);
  });

  it('evicts the least recently shown full-resolution tiles, never pinned previews', () => {
    // Level-0 pool: 2 scratch + 6 cached tiles.
    const p = new PyramidPlanner(8, 64, 2);
    const keys = [0, 1, 16, 17];
    const a = canvas('a', 0, 512, 512, keys);
    const b = canvas('b', 1000, 512, 512, keys);
    settle(p, [a, b], { x: 0, y: 0, width: 512, height: 512 });
    expect(p.cachedTiles('a')[0]).toBe(4);
    settle(p, [a, b], { x: 1000, y: 0, width: 512, height: 512 });
    expect(p.cachedTiles('b')[0]).toBe(4);
    expect(p.cachedTiles('a')[0]).toBe(2); // two of a's were evicted to make room
    expect(p.cachedTiles('a').slice(PINNED_PREVIEW_LEVEL)).toEqual([1, 1]);
  });

  it('drops a canvas cache when the canvas is resized or removed', () => {
    const p = new PyramidPlanner(64, 64, 8);
    settle(p, [canvas('a', 0, 512, 512, [0])]);
    const used = p.previewPool.usedSlots;
    expect(used).toBeGreaterThan(0);
    settle(p, [canvas('a', 0, 768, 512, [0])]);
    expect(p.cachedTiles('a')[0]).toBe(6);
    p.plan([], everywhere, 0);
    expect(p.previewPool.usedSlots).toBe(0);
  });
});
