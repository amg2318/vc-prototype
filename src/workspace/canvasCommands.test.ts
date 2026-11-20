import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_SIZE } from '../config';
import { tileKey } from '../document/tiles';
import { TileStore } from '../document/tileStore';
import { Workspace } from './workspace';

/** Everything undo/redo should restore, for every canvas in z-order. */
function snapshot(ws: Workspace) {
  return ws.canvases.map((c) => ({
    id: c.id,
    name: c.name,
    placement: c.placement,
    paper: [...c.paper],
    layers: c.layers.map((l) => ({ id: l.id, name: l.name, opacity: l.opacity, tiles: [...l.tiles.entries()].sort((a, b) => a[0] - b[0]) })),
  }));
}

/** Once history is cleared, slots are referenced exactly as often as canvases point at them. */
function expectNoLeaks(ws: Workspace): void {
  ws.history.clear();
  const counts = new Map<number, number>();
  for (const c of ws.canvases) for (const l of c.layers) for (const s of l.tiles.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
  expect(ws.store.usedSlots).toBe(counts.size);
  for (const [slot, n] of counts) expect(ws.store.refCount(slot)).toBe(n);
}

function expectUndoable(ws: Workspace, action: () => void): void {
  const before = snapshot(ws);
  action();
  const after = snapshot(ws);
  expect(after).not.toEqual(before);
  for (let i = 0; i < 2; i++) {
    expect(ws.undo()).not.toBeNull();
    expect(snapshot(ws)).toEqual(before);
    expect(ws.redo()).not.toBeNull();
    expect(snapshot(ws)).toEqual(after);
  }
}

/** A workspace with one 1000 × 1000 canvas that has painted tiles. */
function setup() {
  const ws = new Workspace(new TileStore(64));
  const doc = ws.createCanvas({ width: 1000, height: 1000 }, { x: 0, y: 0 });
  const e = ws.editor(doc.id);
  e.commitStroke(e.activeLayerId, [tileKey(0, 0), tileKey(3, 3)], 'paint');
  ws.history.clear(); // start each test with an empty history
  return { ws, doc, e };
}

describe('canvas commands: undo/redo', () => {
  it('create', () => {
    const { ws } = setup();
    expectUndoable(ws, () => ws.createCanvas({ width: 2480, height: 3508 }, { x: 1200, y: 0 }, 'A4'));
    expect(ws.canvases[1]!.name).toBe('A4');
    expect(ws.activeCanvasId).toBe(ws.canvases[1]!.id);
    expectNoLeaks(ws);
  });

  it('duplicate shares tiles and places the copy beside the original', () => {
    const { ws, doc } = setup();
    expectUndoable(ws, () => ws.duplicateCanvas(doc.id));
    const copy = ws.canvases[1]!;
    expect(copy.name).toBe('Canvas 1 copy');
    expect(copy.x).toBe(1100);
    expect(copy.layers[0]!.tiles.get(tileKey(0, 0))).toBe(doc.layers[0]!.tiles.get(tileKey(0, 0)));
    expect(copy.layers[0]!.id).not.toBe(doc.layers[0]!.id);
    expectNoLeaks(ws);
  });

  it('delete keeps the canvas (and its tiles) for undo', () => {
    const { ws, doc } = setup();
    const used = ws.store.usedSlots;
    expectUndoable(ws, () => ws.deleteCanvas(doc.id));
    ws.undo(); // canvas back
    ws.redo(); // deleted again
    expect(ws.store.usedSlots).toBe(used); // still held by history
    expect(ws.historyBytes()).toBeGreaterThan(0);
    expectNoLeaks(ws); // clearing history releases them
    expect(ws.store.usedSlots).toBe(0);
    expect(() => ws.canvas(doc.id)).toThrow();
  });

  it('a deleted canvas undone and then abandoned keeps nothing', () => {
    const { ws } = setup();
    const created = ws.createCanvas({ width: 512, height: 512 }, { x: 0, y: 0 });
    const ce = ws.editor(created.id);
    ce.commitStroke(ce.activeLayerId, [0, 1], 'paint');
    ws.undo(); // stroke
    ws.undo(); // creation
    ws.renameCanvas(ws.canvases[0]!.id, 'new branch'); // drops the redo stack
    expect(() => ws.canvas(created.id)).toThrow();
    expectNoLeaks(ws);
  });

  it('move, with one undo step per drag', () => {
    const { ws, doc } = setup();
    expectUndoable(ws, () => ws.moveCanvas(doc.id, 300, -40));
    ws.history.clear();
    for (const x of [310, 320, 330]) ws.moveCanvas(doc.id, x, 0, 'drag-1');
    expect(ws.history.undoCount).toBe(1);
    ws.undo();
    expect([doc.x, doc.y]).toEqual([300, -40]);
  });

  it('rename', () => {
    const { ws, doc } = setup();
    expectUndoable(ws, () => ws.renameCanvas(doc.id, 'Page 1'));
    ws.renameCanvas(doc.id, '   '); // ignored
    expect(doc.name).toBe('Page 1');
  });

  it('bring to front', () => {
    const { ws, doc } = setup();
    ws.createCanvas({ width: 100, height: 100 }, { x: 0, y: 0 });
    ws.history.clear();
    expectUndoable(ws, () => ws.bringToFront(doc.id));
    expect(ws.canvases[1]).toBe(doc);
    expect(ws.activeCanvasId).toBe(doc.id);
  });

  it('resize: extend reuses tiles, crop and shift make GPU jobs, undo restores both', () => {
    const { ws, doc } = setup();
    let jobs: ReturnType<Workspace['resizeCanvas']> = null;
    expectUndoable(ws, () => (jobs = ws.resizeCanvas(doc.id, { width: 2000, height: 2000 }, { x: 0, y: 0 })));
    expect(jobs).toEqual([]);

    expectUndoable(ws, () => (jobs = ws.resizeCanvas(doc.id, { width: 700, height: 700 }, { x: 0, y: 0 })));
    // Tile (3,3) lies outside 700 px and is dropped; (0,0) is kept as-is.
    expect(jobs).toEqual([]);
    expect([...doc.layers[0]!.tiles.keys()]).toEqual([tileKey(0, 0)]);

    expectUndoable(ws, () => (jobs = ws.resizeCanvas(doc.id, { width: 800, height: 800 }, { x: 0.5, y: 0.5 })));
    expect(jobs!.length).toBeGreaterThan(0); // an unaligned shift redraws the tiles
    expect(doc.placement).toEqual({ x: -50, y: -50, width: 800, height: 800 });
    expectNoLeaks(ws);
  });

  it('resize clamps to the maximum canvas size', () => {
    const { ws, doc } = setup();
    ws.resizeCanvas(doc.id, { width: 99999, height: 0 }, { x: 0, y: 0 });
    expect([doc.width, doc.height]).toEqual([MAX_CANVAS_SIZE, 1]);
  });

  it('resize refuses when the pool is full even after dropping history', () => {
    const ws = new Workspace(new TileStore(4));
    const doc = ws.createCanvas({ width: 1000, height: 1000 }, { x: 0, y: 0 });
    const e = ws.editor(doc.id);
    e.commitStroke(e.activeLayerId, [0, 1, 16, 17], 'paint'); // all 4 slots in use
    expect(ws.resizeCanvas(doc.id, { width: 900, height: 900 }, { x: 0.5, y: 0.5 })).toBeNull();
    expect(doc.width).toBe(1000);
  });
});

describe('undo across canvases', () => {
  it('reports which canvas each undo touched', () => {
    const { ws, doc } = setup();
    const other = ws.createCanvas({ width: 512, height: 512 }, { x: 5000, y: 0 });
    const oe = ws.editor(other.id);
    oe.commitStroke(oe.activeLayerId, [0], 'paint');
    ws.editor(doc.id).commitStroke(ws.editor(doc.id).activeLayerId, [1], 'paint');
    expect(ws.undo()!.canvasId).toBe(doc.id);
    expect(ws.undo()!.canvasId).toBe(other.id);
    const creation = ws.undo()!;
    expect(creation.canvasId).toBe(other.id);
    expect(creation.workspace).toBe(true);
  });
});
