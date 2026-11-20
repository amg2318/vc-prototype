import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '../config';
import { tileKey } from '../document/tiles';
import { screenToDoc } from '../viewport/viewport';
import {
  canvasPointToTile,
  canvasTilesInRect,
  canvasToWorkspace,
  cullToRect,
  hitTest,
  intersect,
  tileGridSize,
  union,
  visibleWorkspaceRect,
  workspaceToCanvas,
} from './coords';

const a4 = { x: 1000, y: -500, width: 2480, height: 3508 };

describe('workspace ↔ canvas ↔ tile', () => {
  it('round-trips between workspace and canvas space', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 1234.5, y: -77.25 }, { x: 3479, y: 3007 }]) {
      expect(canvasToWorkspace(a4, workspaceToCanvas(a4, p))).toEqual(p);
    }
    expect(workspaceToCanvas(a4, { x: 1000, y: -500 })).toEqual({ x: 0, y: 0 });
  });

  it('finds the tile under a canvas point, and nothing outside the canvas', () => {
    expect(canvasPointToTile(a4, { x: 0, y: 0 })).toEqual({ tx: 0, ty: 0 });
    expect(canvasPointToTile(a4, { x: TILE_SIZE, y: TILE_SIZE - 0.5 })).toEqual({ tx: 1, ty: 0 });
    expect(canvasPointToTile(a4, { x: 2479.9, y: 3507.9 })).toEqual({ tx: 9, ty: 13 });
    expect(canvasPointToTile(a4, { x: 2480, y: 10 })).toBeNull();
    expect(canvasPointToTile(a4, { x: -0.1, y: 10 })).toBeNull();
  });

  it('sizes the tile grid, including a partial last row/column', () => {
    expect(tileGridSize(a4)).toEqual({ cols: 10, rows: 14 });
    expect(tileGridSize({ width: 2048, height: 2048 })).toEqual({ cols: 8, rows: 8 });
  });

  it('lists tiles in a rect, clipped to the canvas', () => {
    expect(canvasTilesInRect(a4, { x: 250, y: 10, width: 10, height: 10 })).toEqual([tileKey(0, 0), tileKey(1, 0)]);
    expect(canvasTilesInRect(a4, { x: 2400, y: 3400, width: 500, height: 500 })).toEqual([tileKey(9, 13)]);
    expect(canvasTilesInRect(a4, { x: -500, y: -500, width: 100, height: 100 })).toEqual([]);
  });
});

describe('rectangles', () => {
  it('intersects and unions', () => {
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5, y: 5, width: 5, height: 5,
    });
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
    expect(union([{ x: 0, y: 0, width: 1, height: 1 }, { x: -5, y: 3, width: 2, height: 2 }])).toEqual({
      x: -5, y: 0, width: 6, height: 5,
    });
    expect(union([])).toBeNull();
  });
});

describe('viewport culling', () => {
  const canvases = [
    { id: 'a', placement: { x: 0, y: 0, width: 1000, height: 1000 } },
    { id: 'b', placement: { x: 5000, y: 0, width: 1000, height: 1000 } },
    { id: 'c', placement: { x: 500, y: 500, width: 1000, height: 1000 } },
  ];

  it('maps the screen to a workspace rect', () => {
    const view = { scale: 0.5, rotation: 0, tx: 100, ty: 50 };
    expect(visibleWorkspaceRect(view, 800, 600)).toEqual({ x: -200, y: -100, width: 1600, height: 1200 });
  });

  it('covers every screen corner when rotated', () => {
    const view = { scale: 2, rotation: 0.7, tx: 300, ty: -40 };
    const r = visibleWorkspaceRect(view, 1000, 700);
    for (const corner of [{ x: 0, y: 0 }, { x: 1000, y: 700 }, { x: 1000, y: 0 }, { x: 0, y: 700 }]) {
      const p = screenToDoc(view, corner);
      expect(p.x).toBeGreaterThanOrEqual(r.x - 1e-9);
      expect(p.x).toBeLessThanOrEqual(r.x + r.width + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(r.y - 1e-9);
      expect(p.y).toBeLessThanOrEqual(r.y + r.height + 1e-9);
    }
  });

  it('keeps only the canvases intersecting the view, in z-order', () => {
    expect(cullToRect(canvases, { x: 900, y: 900, width: 50, height: 50 }).map((c) => c.id)).toEqual(['a', 'c']);
    expect(cullToRect(canvases, { x: 2000, y: 2000, width: 10, height: 10 })).toEqual([]);
    expect(cullToRect(canvases, { x: -1e6, y: -1e6, width: 2e6, height: 2e6 })).toHaveLength(3);
  });

  it('hit-tests the topmost canvas', () => {
    expect(hitTest(canvases, { x: 700, y: 700 })?.id).toBe('c');
    expect(hitTest(canvases, { x: 100, y: 100 })?.id).toBe('a');
    expect(hitTest(canvases, { x: 3000, y: 100 })).toBeNull();
  });
});
