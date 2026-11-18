import { describe, expect, it } from 'vitest';
import { tileKey } from '../document/tiles';
import { PyramidPlanner } from './pyramid';
import { clipQuad, RenderCore, retileCopies, SOLID_QUAD_FLOATS } from './renderCore';
import type { CanvasRenderState, ViewState } from './renderer';

function canvas(id: string, x: number, painted: number[] = []): CanvasRenderState {
  return {
    id,
    placement: { x, y: 0, width: 512, height: 512 },
    paper: [1, 1, 1],
    sources: [{ kind: 'raster', opacity: 1, blendMode: 'normal', tiles: new Map(painted.map((k, i) => [k, i])) }],
    liveStroke: null,
  };
}

/** A 1000 × 1000 px screen showing workspace (0,0)–(1000,1000) at 100%. */
const view: ViewState = {
  workspaceToClip: new Float64Array([2 / 1000, 0, 0, 0, -2 / 1000, 0, -1, 1, 1]),
  visible: { x: 0, y: 0, width: 1000, height: 1000 },
  canvasPxPerDevicePx: 1,
};
const px: [number, number] = [2 / 1000, 2 / 1000];

describe('clipQuad', () => {
  it('maps a workspace rect to a clip-space origin and axes', () => {
    expect(clipQuad(view.workspaceToClip, { x: 0, y: 0, width: 500, height: 250 })).toEqual([-1, 1, 1, 0, 0, -0.5]);
    // Far from the origin, positions are still exact (doubles on the CPU).
    const far = new Float64Array([1e-6, 0, 0, 0, -1e-6, 0, -1e6 * 1e-6, 1, 1]);
    expect(clipQuad(far, { x: 1e6 + 1, y: 0, width: 1, height: 1 })[0]).toBeCloseTo(1e-6, 12);
  });
});

describe('retileCopies', () => {
  it('zeroes each new tile and copies the parts of its sources inside the kept region', () => {
    const op = retileCopies([
      { key: 0, dst: 9, keep: { x: 0, y: 0, width: 200, height: 256 }, sources: [{ src: 3, dx: 100, dy: 0 }] },
    ]);
    expect(op.zero).toEqual([9]);
    expect(op.copies).toEqual([{ src: 3, sx: 0, sy: 0, dst: 9, dx: 100, dy: 0, width: 100, height: 256 }]);
  });

  it('copies from the right part of a source shifted up-left', () => {
    const op = retileCopies([
      { key: 0, dst: 1, keep: { x: 0, y: 0, width: 256, height: 256 }, sources: [{ src: 2, dx: -156, dy: -56 }] },
    ]);
    expect(op.copies[0]).toEqual({ src: 2, sx: 156, sy: 56, dst: 1, dx: 0, dy: 0, width: 100, height: 200 });
  });
});

describe('RenderCore', () => {
  it('draws each visible canvas as a shadow then its tiles, back to front', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    core.setCanvases([canvas('a', 0, [0]), canvas('b', 300, [0])]);
    core.buildFrame(view, px); // first frame builds the tiles
    const frame = core.buildFrame(view, px);
    expect(frame.stats.visibleCanvases).toBe(2);
    const kinds = frame.display.runs.map((r) => r.kind);
    expect(kinds).toEqual(['solid', 'tile', 'solid', 'tile']);
    // The second solid run is b's shadow, drawn over a.
    const shadowB = frame.display.runs[2]!;
    expect(shadowB.kind === 'solid' && frame.display.solids[shadowB.first * SOLID_QUAD_FLOATS + 9]).toBeCloseTo(0.35);
  });

  it('uploads a canvas’s compositor inputs only when they changed', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    core.setCanvases([canvas('a', 0, [0])]);
    const first = core.buildFrame(view, px);
    expect(first.composites[0]!.upload).not.toBeNull();
    core.invalidate('a', [0]);
    expect(core.buildFrame(view, px).composites[0]!.upload).toBeNull();
    core.setCanvases([canvas('a', 0, [0])]);
    core.invalidate('a', [0]);
    expect(core.buildFrame(view, px).composites[0]!.upload).not.toBeNull();
  });

  it('recomposites the tiles under a stroke, ignoring dabs past the canvas edge', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    const c = canvas('a', 0);
    core.setCanvases([c]);
    core.buildFrame(view, px);
    core.beginStroke('a');
    core.setCanvases([{ ...c, liveStroke: { sourceIndex: 0, style: { color: [0, 0, 0], opacity: 1, mode: 'paint' } } }]);
    core.addDabs([{ x: 10, y: 10, radius: 4, opacity: 1 }, { x: 900, y: 10, radius: 4, opacity: 1 }]);
    const frame = core.buildFrame(view, px);
    const keys = frame.composites.flatMap((b) => [...b.instances].filter((_, i) => i % 4 === 2 || i % 4 === 3));
    expect(keys).toEqual([0, 0]); // only tile (0,0): its origin is (0, 0)
    expect(frame.ops.map((o) => o.kind)).toEqual(['clearMask', 'dabs']);
  });

  it('reports removed canvases once', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 8));
    core.setCanvases([canvas('a', 0)]);
    core.buildFrame(view, px);
    core.setCanvases([]);
    expect(core.buildFrame(view, px).removedCanvases).toEqual(['a']);
    expect(core.buildFrame(view, px).removedCanvases).toEqual([]);
  });

  it('draws overlay rects last', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    core.setCanvases([canvas('a', 0, [tileKey(0, 0)])]);
    core.setOverlay([{ rect: { x: 0, y: 0, width: 10, height: 10 }, color: [0, 0.5, 1, 1] }]);
    const frame = core.buildFrame(view, px);
    const last = frame.display.runs[frame.display.runs.length - 1]!;
    expect(last.kind).toBe('solid');
  });
});
