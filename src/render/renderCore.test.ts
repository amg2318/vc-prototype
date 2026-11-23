import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileStore } from '../document/tileStore';
import { tileKey } from '../document/tiles';
import { buildCanvasState } from '../app/compositeState';
import { createBlock } from '../document/inheritedBlock';
import { singleCanvasEditor } from '../workspace/workspace';
import { TileResidency } from './residency';
import { CompressedTileStore } from './tileBackingStore';
import { PyramidPlanner } from './pyramid';
import { backgroundGrid, clipQuad, dirtyRect, RenderCore, retileCopies, SOLID_QUAD_FLOATS } from './renderCore';
import type { CanvasRenderState, ViewState } from './renderer';
import type { Frame } from './renderCore';

/** Every composite batch of a frame, whatever its stage. */
function allComposites(frame: Frame) {
  return frame.stages.flatMap((s) => s.composites);
}

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
    const [op] = retileCopies([
      { key: 0, dst: 9, keep: { x: 0, y: 0, width: 200, height: 256 }, sources: [{ src: 3, dx: 100, dy: 0 }] },
    ]) as [ReturnType<typeof retileCopies>[number]];
    expect(op.zero).toEqual([9]);
    expect(op.copies).toEqual([{ src: 3, sx: 0, sy: 0, dst: 9, dx: 100, dy: 0, width: 100, height: 256 }]);
  });

  it('copies from the right part of a source shifted up-left', () => {
    const [op] = retileCopies([
      { key: 0, dst: 1, keep: { x: 0, y: 0, width: 256, height: 256 }, sources: [{ src: 2, dx: -156, dy: -56 }] },
    ]) as [ReturnType<typeof retileCopies>[number]];
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


  it('recomposites the tiles under a stroke, ignoring dabs past the canvas edge', () => {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    const c = canvas('a', 0);
    core.setCanvases([c]);
    core.buildFrame(view, px);
    core.beginStroke('a');
    core.setCanvases([{ ...c, liveStroke: { sourceIndex: 0, style: { color: [0, 0, 0], opacity: 1, mode: 'paint' } } }]);
    core.addDabs([{ x: 10, y: 10, radius: 4, opacity: 1 }, { x: 900, y: 10, radius: 4, opacity: 1 }]);
    const frame = core.buildFrame(view, px);
    const keys = allComposites(frame).flatMap((b) => [...b.instances].filter((_, i) => i % 4 === 2 || i % 4 === 3));
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

describe('RenderCore with tile residency', () => {
  const style = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  /** A core whose GPU holds only `capacity` layer tiles. */
  const small = (capacity: number) => new RenderCore(new PyramidPlanner(64, 64, 64), new TileResidency(capacity, new CompressedTileStore()));
  const kinds = (frame: { ops: { kind: string }[] }) => frame.ops.map((o) => o.kind);

  it('reads a tile back before reusing its slot for a new tile', () => {
    const core = small(1);
    core.setCanvases([canvas('a', 0)]);
    core.merge('a', [{ key: 0, src: null, dst: 100 }], style);
    expect(kinds(core.buildFrame(view, px))).toEqual(['merge']);
    core.merge('a', [{ key: 1, src: null, dst: 101 }], style);
    const frame = core.buildFrame(view, px);
    expect(kinds(frame)).toEqual(['evict', 'merge']);
    const [evict, merge] = frame.ops as unknown as [{ kind: 'evict'; slot: number }, { kind: 'merge'; jobs: { dst: number }[] }];
    expect(merge.jobs[0]!.dst).toBe(evict.slot);
  });

  /** Tiles 100 and 101 written, then 103, which evicts 100 (read back as 9s). */
  async function withEvictedTile() {
    const core = small(2);
    core.setCanvases([canvas('a', 0)]);
    core.merge('a', [{ key: 0, src: null, dst: 100 }, { key: 1, src: null, dst: 101 }], style);
    core.buildFrame(view, px);
    core.merge('a', [{ key: 16, src: null, dst: 103 }], style);
    const evict = core.buildFrame(view, px).ops[0] as { kind: 'evict'; done: (rgba: Uint8Array) => void };
    evict.done(new Uint8Array(TILE_BYTES).fill(9));
    await settle();
    return core;
  }

  it('holds a merge until its evicted source tile is back, then uploads it first', async () => {
    const core = await withEvictedTile();
    core.merge('a', [{ key: 0, src: 100, dst: 102 }], style); // a stroke over tile 100
    expect(kinds(core.buildFrame(view, px))).toEqual([]); // waits: tile 100 is reloading
    await settle();
    const frame = core.buildFrame(view, px);
    expect(kinds(frame)).toEqual(['evict', 'upload', 'evict', 'merge']);
    const upload = frame.ops[1] as { kind: 'upload'; slot: number; rgba: Uint8Array };
    expect(upload.rgba[0]).toBe(9);
  });

  it('keeps showing the old composite while a new tile waits to be written', async () => {
    const core = await withEvictedTile();
    core.merge('a', [{ key: 0, src: 100, dst: 102 }], style);
    // The document already shows the new tile 102 at key 0.
    core.setCanvases([{ ...canvas('a', 0), sources: [{ kind: 'raster', opacity: 1, blendMode: 'normal', tiles: new Map([[0, 102]]) }] }]);
    core.invalidate('a', [0]);
    const waiting = core.buildFrame(view, px);
    const origins = allComposites(waiting).flatMap((b) => [...b.instances].filter((_, i) => i % 4 >= 2));
    expect(origins).not.toContain(0); // tile (0,0) is not recomposited yet
    await settle();
    const ran = core.buildFrame(view, px); // the merge runs first, then tile (0,0) is recomposited
    expect(kinds(ran)).toContain('merge');
    expect(allComposites(ran).flatMap((b) => [...b.instances].filter((_, i) => i % 4 >= 2))).toContain(0);
  });

  it('puts GPU slots, not tile ids, in the compositor lookup', () => {
    const core = small(4);
    core.setCanvases([canvas('a', 0)]);
    core.merge('a', [{ key: 0, src: null, dst: 500 }], style);
    core.buildFrame(view, px);
    core.setCanvases([{ ...canvas('a', 0), sources: [{ kind: 'raster', opacity: 1, blendMode: 'normal', tiles: new Map([[0, 500]]) }] }]);
    core.invalidate('a', [0]);
    const batch = allComposites(core.buildFrame(view, px))[0]!;
    expect(batch.upload.lookup[0]).toBe(1); // tile 500 is in GPU slot 0 (stored as slot + 1)
  });

  it('skips writing tiles that were freed while their work waited', () => {
    const core = small(1);
    const store = new TileStore(1000);
    core.useTileStore(store);
    core.setCanvases([canvas('a', 0)]);
    const id = store.allocate()!;
    store.release(id);
    core.merge('a', [{ key: 0, src: null, dst: id }], style);
    expect(kinds(core.buildFrame(view, px))).toEqual([]);
    expect(core.residency.stats().resident).toBe(0);
  });
});

describe('undo with evicted tiles', () => {
  it('brings back the evicted "before" tiles of an undone stroke', async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const style = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };
    const editor = singleCanvasEditor(undefined, undefined, { width: 512, height: 512 });
    const core = new RenderCore(new PyramidPlanner(64, 64, 64), new TileResidency(4, new CompressedTileStore()));
    core.useTileStore(editor.store);
    const sync = () => core.setCanvases([buildCanvasState(editor.doc, null)]);
    /** Run frames, answering eviction readbacks with recognisable pixels. */
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const frame = core.buildFrame(view, px);
        for (const op of frame.ops) if (op.kind === 'evict') op.done(new Uint8Array(TILE_BYTES).fill(op.slot + 1));
        await settle();
      }
    };
    sync();
    const stroke = (keys: number[]) => {
      core.merge(editor.doc.id, editor.commitStroke(editor.activeLayerId, keys, 'paint')!, style);
      sync();
    };

    stroke([0, 1]); // tiles A at keys 0 and 1
    await frames(1);
    const before = [...editor.doc.layers[0]!.tiles.values()];
    stroke([0, 1]); // replaces them; the old ones stay only in history
    stroke([tileKey(0, 1), tileKey(1, 1)]); // more tiles: the GPU (4 slots) must evict
    await frames(2);
    const evicted = before.filter((id) => !core.residency.isResident(id));
    expect(evicted.length).toBeGreaterThan(0);
    const reloadsBefore = core.residency.stats().reloads;

    editor.undo();
    editor.undo(); // the layer shows the evicted "before" tiles again
    sync();
    core.invalidate(editor.doc.id, 'all');
    await frames(4);
    // Every evicted "before" tile was reloaded to recomposite the canvas.
    expect(core.residency.stats().reloads - reloadsBefore).toBeGreaterThanOrEqual(evicted.length);
    expect(core.residency.stats().loading).toBe(0);
  });
});

describe('backgroundGrid', () => {
  it('spaces lines by a power of two of the tile size, at least 48 device px apart', () => {
    // Zoomed out 8×: 256 px would be 32 device px apart, so the spacing is 512.
    const lines = backgroundGrid({ x: -100, y: 0, width: 1100, height: 600 }, 8);
    const xs = lines.filter((l) => l.rect.height === 600).map((l) => l.rect.x);
    expect(xs).toEqual([0, 512]); // the view spans x = -100 … 1000
  });

  it('keeps the line count small at any zoom', () => {
    for (const zoom of [0.01, 1, 37, 1000]) {
      const visible = { x: 0, y: 0, width: 2000 * zoom, height: 1500 * zoom };
      expect(backgroundGrid(visible, zoom).length).toBeLessThan(100);
    }
  });
});

describe('dirtyRect', () => {
  const size = { width: 300, height: 600 };
  it('covers the changed tiles, clipped to the canvas', () => {
    expect(dirtyRect([tileKey(1, 0), tileKey(1, 2)], size)).toEqual({ x: 256, y: 0, width: 44, height: 600 });
  });
  it('is the whole canvas for "all", and null for nothing', () => {
    expect(dirtyRect('all', size)).toEqual({ x: 0, y: 0, width: 300, height: 600 });
    expect(dirtyRect([], size)).toBeNull();
  });
});

describe('RenderCore: composite change events', () => {
  /** a → b → c, all 512 × 512 with identity blocks. */
  function chain(): { core: RenderCore; events: [string, unknown][] } {
    const core = new RenderCore(new PyramidPlanner(64, 64, 64));
    const block = (source: string) => createBlock(source, { width: 512, height: 512 }, { width: 512, height: 512 });
    core.setCanvases([canvas('a', 0), { ...canvas('b', 600), inherited: block('a') }, { ...canvas('c', 1200), inherited: block('b') }]);
    core.buildFrame(view, px);
    const events: [string, unknown][] = [];
    core.onCompositeChanged = (id, rect) => events.push([id, rect]);
    return { core, events };
  }

  it('sends one merged event per canvas per frame, sources first, down the chain', () => {
    const { core, events } = chain();
    core.invalidate('a', [tileKey(0, 0)]);
    core.invalidate('a', [tileKey(1, 0)]);
    expect(events).toEqual([]); // nothing until the frame
    core.buildFrame(view, px);
    expect(events.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(events[0]![1]).toEqual({ x: 0, y: 0, width: 512, height: 256 });
    expect(core.inheritorsUpdated).toBe(2);
    core.buildFrame(view, px);
    expect(events).toHaveLength(3); // nothing new
    expect(core.inheritorsUpdated).toBe(0);
  });

  it('recomposites a whole inheritor when its block changes', () => {
    const { core, events } = chain();
    const b = core.canvas('b')!;
    core.setCanvases([core.canvas('a')!, { ...b, inherited: { ...b.inherited!, opacity: 0.5 } }, core.canvas('c')!]);
    core.buildFrame(view, px);
    expect(events).toEqual([
      ['b', { x: 0, y: 0, width: 512, height: 512 }],
      ['c', { x: 0, y: 0, width: 512, height: 512 }],
    ]);
  });
});

describe('RenderCore: inherited blocks', () => {
  const size = { width: 512, height: 512 };
  /** a and b off screen, c on screen; c inherits b, b inherits a (identity blocks). */
  function offscreenChain(): RenderCore {
    const core = new RenderCore(new PyramidPlanner(256, 256, 16));
    core.setCanvases([
      canvas('a', 5000, [0]),
      { ...canvas('b', 6000), inherited: createBlock('a', size, size) },
      { ...canvas('c', 0), inherited: createBlock('b', size, size) },
    ]);
    return core;
  }

  it('keeps the whole upstream chain of a visible inheritor built at the needed level, even off screen', () => {
    const core = offscreenChain();
    for (let i = 0; i < 3; i++) core.buildFrame(view, px);
    // Off-screen canvases normally keep only the always-kept levels (3 and 4).
    expect(core.planner.cachedTiles('a')[0]).toBe(4);
    expect(core.planner.cachedTiles('b')[0]).toBe(4);
  });

  it('composites sources before inheritors, inheritors through the staging target', () => {
    const core = offscreenChain();
    const frame = core.buildFrame(view, px);
    expect(frame.stages.map((s) => s.depth)).toEqual([0, 1, 2]);
    const [a, b, c] = frame.stages.map((s) => s.composites[0]);
    expect(a?.staged ?? null).toBeNull();
    expect(b!.staged).not.toBeNull();
    expect(c!.upload.blockLookup).not.toBeNull();
    expect(c!.upload.uniforms[11]).toBe(2048); // renders into the staging target
    expect(frame.stats.inheritorTiles).toBeGreaterThan(0);
  });

  it("composites an inheritor again once its source's tiles are up to date", () => {
    const core = offscreenChain();
    for (let i = 0; i < 3; i++) core.buildFrame(view, px);
    // A tiny budget: the source can't rebuild all of a big change in one frame.
    core.invalidate('a', 'all');
    let frames = 0;
    while (core.buildFrame(view, px).moreWork && frames < 20) frames++;
    expect(frames).toBeLessThan(20); // settles
    const quiet = core.buildFrame(view, px);
    expect(quiet.stats.inheritorTiles).toBe(0);
  });

  it('finishes a big change down a visible chain with a small budget (sources go first)', () => {
    const big = { width: 1024, height: 1024 };
    const at = (id: string, x: number, inherits?: string): CanvasRenderState => ({
      ...canvas(id, x, inherits ? [] : [0]),
      placement: { x, y: 0, width: 1024, height: 1024 },
      inherited: inherits ? createBlock(inherits, big, big) : null,
    });
    const core = new RenderCore(new PyramidPlanner(256, 256, 4));
    core.setCanvases([at('a', 0), at('b', 1100, 'a'), at('c', 2200, 'b'), at('d', 3300, 'c')]);
    const wide: ViewState = { ...view, visible: { x: 0, y: 0, width: 4400, height: 1100 }, canvasPxPerDevicePx: 4 };
    let frames = 0;
    while (core.buildFrame(wide, px).moreWork && frames < 200) frames++;
    core.invalidate('a', 'all');
    frames = 0;
    while (core.buildFrame(wide, px).moreWork && frames < 200) frames++;
    expect(frames).toBeLessThan(200);
  });

  it('defers off-screen inheritors during a stroke and catches them up afterwards', () => {
    const core = new RenderCore(new PyramidPlanner(256, 256, 16));
    const a = canvas('a', 0);
    const onScreen = { ...canvas('b', 600), inherited: createBlock('a', size, size) };
    const offScreen = { ...canvas('c', 5000), inherited: createBlock('a', size, size) };
    core.setCanvases([a, onScreen, offScreen]);
    for (let i = 0; i < 3; i++) core.buildFrame(view, px);

    const drawing = { ...a, liveStroke: { sourceIndex: 0, style: { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const } } };
    core.setCanvases([drawing, onScreen, offScreen]);
    core.beginStroke('a');
    core.addDabs([{ x: 10, y: 10, radius: 4, opacity: 1 }]);
    const during = core.buildFrame(view, px);
    const composited = (f: Frame) => new Set(allComposites(f).map((b) => b.canvasId));
    expect(composited(during)).toEqual(new Set(['a', 'b'])); // c waits…
    expect(during.stats.staleInheritors).toBe(1);
    expect(during.stats.inheritorsUpdated).toBe(2); // …but is still told about the change

    core.setCanvases([a, onScreen, offScreen]); // pen up
    const after = core.buildFrame(view, px);
    expect(composited(after).has('c')).toBe(true);
    expect(after.stats.staleInheritors).toBe(0);
  });

  it('reports each inheritor once it has caught up with a change, with its depth', () => {
    const core = new RenderCore(new PyramidPlanner(256, 256, 16));
    core.setCanvases([
      canvas('a', 0),
      { ...canvas('b', 520), inherited: createBlock('a', size, size) },
      { ...canvas('c', 0), placement: { x: 0, y: 520, width: 512, height: 512 }, inherited: createBlock('b', size, size) },
    ]);
    for (let i = 0; i < 4; i++) core.buildFrame(view, px);
    core.invalidate('a', [0]);
    const caught = [];
    for (let i = 0; i < 6; i++) caught.push(...core.buildFrame(view, px).stats.caughtUp);
    expect(caught.map((c) => [c.canvasId, c.depth])).toEqual([['b', 1], ['c', 2]]);
    expect(caught.every((c) => c.since <= performance.now())).toBe(true);
  });

  it('does not defer an off-screen source that a visible inheritor shows', () => {
    const core = offscreenChain();
    for (let i = 0; i < 3; i++) core.buildFrame(view, px);
    const a = core.canvas('a')!;
    core.setCanvases([{ ...a, liveStroke: { sourceIndex: 0, style: { color: [0, 0, 0], opacity: 1, mode: 'paint' } } }, core.canvas('b')!, core.canvas('c')!]);
    core.invalidate('a', [0]);
    const frame = core.buildFrame(view, px);
    expect(frame.stats.staleInheritors).toBe(0); // b is off screen, but c (visible) needs it
    expect(frame.stats.maxDepth).toBe(2);
  });

  it('treats tiles under the block as content, not plain paper', () => {
    const core = new RenderCore(new PyramidPlanner(256, 256, 16));
    core.setCanvases([canvas('a', 600), { ...canvas('c', 0), inherited: createBlock('a', size, size) }]);
    const frame = core.buildFrame(view, px);
    const c = frame.stages.flatMap((s) => s.composites).find((b) => b.canvasId === 'c');
    expect(c?.instances.length).toBe(4 * 4); // all four tiles of c
  });
});

describe('RenderCore.readLayerTiles (Phase 4 saving)', () => {
  function setup() {
    const store = new TileStore(64);
    const core = new RenderCore(new PyramidPlanner(64, 64, 64), new TileResidency(64, new CompressedTileStore()));
    core.useTileStore(store);
    core.setCanvases([canvas('a', 0)]);
    return { store, core };
  }
  const style = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };
  const tileReadbacks = (frame: Frame) => frame.readbacks.filter((r) => r.kind === 'tiles');

  it('reads a tile only after its pixels are written, and a capped number per frame', () => {
    const { store, core } = setup();
    const ids = Array.from({ length: 20 }, () => store.allocate()!);
    core.merge('a', ids.map((dst, i) => ({ key: i, src: null, dst })), style);
    void core.readLayerTiles(ids);
    const first = core.buildFrame(view, px);
    // The merge runs in this frame, before the reads (16 of the 20).
    const [read] = tileReadbacks(first);
    expect(read && read.kind === 'tiles' && read.slots).toHaveLength(16);
    expect(first.moreWork).toBe(true);
    const second = core.buildFrame(view, px);
    const [rest] = tileReadbacks(second);
    expect(rest && rest.kind === 'tiles' && rest.slots).toHaveLength(4);
  });

  it('answers null for a tile freed before it was read', async () => {
    const { store, core } = setup();
    const id = store.allocate()!;
    const read = core.readLayerTiles([id]);
    store.release(id);
    core.buildFrame(view, px);
    expect(await read).toEqual([null]);
  });

  it('passes the pixels the backend read back to the caller', async () => {
    const { store, core } = setup();
    const id = store.allocate()!;
    core.merge('a', [{ key: 0, src: null, dst: id }], style);
    const read = core.readLayerTiles([id]);
    const [readback] = tileReadbacks(core.buildFrame(view, px));
    const pixels = new Uint8Array(TILE_BYTES).fill(9);
    if (readback?.kind === 'tiles') readback.resolve([pixels]);
    expect(await read).toEqual([pixels]);
  });
});
