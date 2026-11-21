import { describe, expect, it } from 'vitest';
import { TileStore } from '../document/tileStore';
import { Workspace } from './workspace';

/** Every canvas's block (and the rest undo must restore), in z-order. */
function snapshot(ws: Workspace) {
  return ws.canvases.map((c) => ({ id: c.id, placement: c.placement, inherited: c.inherited }));
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

/** Three canvases a (400 × 200), b and c (200 × 200), none linked, empty history. */
function setup() {
  const ws = new Workspace(new TileStore(16));
  const a = ws.createCanvas({ width: 400, height: 200 }, { x: 0, y: 0 }, 'A');
  const b = ws.createCanvas({ width: 200, height: 200 }, { x: 500, y: 0 }, 'B');
  const c = ws.createCanvas({ width: 200, height: 200 }, { x: 800, y: 0 }, 'C');
  ws.history.clear();
  return { ws, a, b, c };
}

describe('inheritance commands', () => {
  it('create arrow creates a fitted, linked block', () => {
    const { ws, a, b } = setup();
    expectUndoable(ws, () => expect(ws.connect(b.id, a.id)).toBe(true));
    expect(b.inherited?.source).toEqual({ kind: 'linked', canvasId: a.id });
    expect(b.inherited?.placement).toMatchObject({ mode: 'fit', scale: 0.5 });
    expect(ws.history.nextUndoLabel).toBe('Create arrow');
  });

  it('refuses arrows that would make a cycle, leaving history untouched', () => {
    const { ws, a, b, c } = setup();
    ws.connect(b.id, a.id);
    ws.connect(c.id, b.id);
    expect(ws.canConnect(a.id, c.id)).toBe(false);
    expect(ws.connect(a.id, c.id)).toBe(false);
    expect(ws.connect(a.id, a.id)).toBe(false);
    expect(a.inherited).toBeNull();
    expect(ws.history.undoCount).toBe(2);
  });

  it('checks for cycles when retargeting too', () => {
    const { ws, a, b, c } = setup();
    ws.connect(b.id, a.id);
    ws.connect(c.id, b.id);
    expect(ws.connect(b.id, c.id)).toBe(false); // retarget b onto its own inheritor
    expect(ws.connect(c.id, a.id)).toBe(true); // retarget c from b to a
    expect(ws.connect(b.id, c.id)).toBe(true); // now fine: c no longer depends on b
  });

  it('retarget keeps a custom placement and the other settings', () => {
    const { ws, a, b, c } = setup();
    ws.connect(c.id, a.id);
    ws.placeBlock(c.id, { x: 30, rotation: 1 });
    ws.setBlock(c.id, { opacity: 0.4, blendMode: 'screen', effects: [{ kind: 'grayscale' }] });
    expectUndoable(ws, () => ws.connect(c.id, b.id));
    expect(c.inherited).toMatchObject({ opacity: 0.4, blendMode: 'screen', effects: [{ kind: 'grayscale' }] });
    // 400 px wide at 0.5 = 200 px displayed; b is 200 px wide, so the scale becomes 1.
    expect(c.inherited?.placement).toMatchObject({ mode: 'custom', x: 30, rotation: 1, scale: 1 });
    expect(ws.history.nextUndoLabel).toBe('Retarget arrow');
  });

  it('retarget refits a fitted block', () => {
    const { ws, a, b, c } = setup();
    ws.connect(c.id, a.id);
    ws.connect(c.id, b.id);
    expect(c.inherited?.placement).toMatchObject({ mode: 'fit', scale: 1 });
  });

  it('delete arrow leaves an empty slot with its settings; create arrow fills it again', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    ws.setBlock(b.id, { opacity: 0.3 });
    expectUndoable(ws, () => ws.deleteArrow(b.id));
    expect(b.inherited).toMatchObject({ source: { kind: 'empty' }, opacity: 0.3 });
    expect(ws.graph().sourceOf(b.id)).toBeNull();
    expectUndoable(ws, () => ws.connect(b.id, a.id));
    expect(b.inherited).toMatchObject({ source: { kind: 'linked', canvasId: a.id }, opacity: 0.3 });
  });

  it('remove block deletes the slot and its settings', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    expectUndoable(ws, () => ws.removeBlock(b.id));
    expect(b.inherited).toBeNull();
  });

  it('deleting the source marks inheritors missing; undo links them again', () => {
    const { ws, a, b, c } = setup();
    ws.connect(b.id, a.id);
    ws.connect(c.id, a.id);
    ws.setBlock(c.id, { visible: false });
    ws.deleteCanvas(a.id);
    expect(b.inherited?.source).toEqual({ kind: 'missing', lastCanvasId: a.id });
    expect(c.inherited).toMatchObject({ source: { kind: 'missing', lastCanvasId: a.id }, visible: false });
    ws.undo();
    expect(b.inherited?.source).toEqual({ kind: 'linked', canvasId: a.id });
    expect(c.inherited?.source).toEqual({ kind: 'linked', canvasId: a.id });
    ws.redo();
    expect(b.inherited?.source.kind).toBe('missing');
  });

  it('relinks a missing block to another canvas', () => {
    const { ws, a, b, c } = setup();
    ws.connect(b.id, a.id);
    ws.deleteCanvas(a.id);
    expectUndoable(ws, () => ws.connect(b.id, c.id));
    expect(b.inherited?.source).toEqual({ kind: 'linked', canvasId: c.id });
    expect(ws.history.nextUndoLabel).toBe('Relink source');
  });

  it('merges one slider drag into one undo step', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    for (const opacity of [0.9, 0.7, 0.5]) ws.setBlock(b.id, { opacity }, 'Block opacity', 'drag-1');
    for (const x of [10, 20, 30]) ws.placeBlock(b.id, { x }, 'move-1');
    expect(ws.history.undoCount).toBe(3); // create + opacity drag + move drag
    ws.undo();
    expect(b.inherited?.placement.mode).toBe('fit');
    ws.undo();
    expect(b.inherited?.opacity).toBe(1);
  });

  it('transforming makes the placement custom; refit undoes that', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    expectUndoable(ws, () => ws.placeBlock(b.id, { flipX: true }));
    expect(b.inherited?.placement).toMatchObject({ mode: 'custom', flipX: true });
    expectUndoable(ws, () => ws.refitBlock(b.id));
    expect(b.inherited?.placement).toMatchObject({ mode: 'fit', flipX: false });
  });

  it('a crop change refits a fitted block, but not a custom one', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    expectUndoable(ws, () => ws.setBlock(b.id, { crop: { x: 0, y: 0, width: 0.5, height: 1 } }));
    expect(b.inherited?.placement.scale).toBe(1); // 200 × 200 crop fits 200 × 200
    ws.placeBlock(b.id, { scale: 3 });
    ws.setBlock(b.id, { crop: { x: 0, y: 0, width: 0.25, height: 1 } });
    expect(b.inherited?.placement.scale).toBe(3);
  });

  it('duplicating a canvas keeps its block linked to the same source', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    const copy = ws.duplicateCanvas(b.id);
    expect(copy.inherited).toEqual(b.inherited);
    expect(ws.graph().inheritorsOf(a.id)).toEqual([b.id, copy.id]);
  });

  it('resizing a source refits fitted inheritors and keeps custom scales', () => {
    const { ws, a, b, c } = setup();
    ws.connect(b.id, a.id);
    ws.connect(c.id, a.id);
    ws.placeBlock(c.id, { scale: 0.75 });
    expectUndoable(ws, () => ws.resizeCanvas(a.id, { width: 200, height: 200 }, { x: 0, y: 0 }));
    expect(b.inherited?.placement.scale).toBe(1);
    expect(c.inherited?.placement.scale).toBe(0.75);
    expect(c.inherited?.lastSourceSize).toEqual({ width: 200, height: 200 });
  });

  it("resizing an inheritor keeps a custom block where it was in the workspace", () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    ws.placeBlock(b.id, { x: 50, y: 60 });
    // Growing from the bottom-right anchor moves the canvas's top-left corner up and left by 100.
    expectUndoable(ws, () => ws.resizeCanvas(b.id, { width: 300, height: 300 }, { x: 1, y: 1 }));
    expect(b.inherited?.placement).toMatchObject({ x: 150, y: 160 });
  });

  it('undoing past a create arrow and then making the reverse arrow clears redo (no cycle via redo)', () => {
    const { ws, a, b } = setup();
    ws.connect(b.id, a.id);
    ws.undo();
    expect(ws.connect(a.id, b.id)).toBe(true);
    expect(ws.history.canRedo).toBe(false);
  });
});
