import { describe, expect, it } from 'vitest';
import { MAX_LAYERS, TILE_BYTES } from '../config';
import type { Editor } from './editor';
import { singleCanvasEditor } from '../workspace/workspace';
import { TileStore } from './tileStore';

/** Snapshot of everything undo/redo should restore. */
function snapshot(e: Editor) {
  return {
    paper: [...e.doc.paper],
    layers: e.doc.layers.map((l) => ({
      id: l.id,
      name: l.name,
      opacity: l.opacity,
      visible: l.visible,
      blendMode: l.blendMode,
      tiles: [...l.tiles.entries()].sort((a, b) => a[0] - b[0]),
    })),
  };
}

/**
 * Leak check: once history is cleared, every allocated slot must be referenced
 * exactly as many times as layer entries point at it.
 */
function expectNoLeaks(e: Editor): void {
  e.history.clear();
  const counts = new Map<number, number>();
  for (const l of e.doc.layers) for (const s of l.tiles.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
  expect(e.store.usedSlots).toBe(counts.size);
  for (const [slot, n] of counts) expect(e.store.refCount(slot)).toBe(n);
}

/** Run `action`, then check undo restores the state before it and redo the state after. */
function expectUndoable(e: Editor, action: () => void): void {
  const before = snapshot(e);
  action();
  const after = snapshot(e);
  expect(after).not.toEqual(before);
  expect(e.undo()).toBe(true);
  expect(snapshot(e)).toEqual(before);
  expect(e.redo()).toBe(true);
  expect(snapshot(e)).toEqual(after);
  // And once more, to make sure the cycle is repeatable.
  e.undo();
  expect(snapshot(e)).toEqual(before);
  e.redo();
  expect(snapshot(e)).toEqual(after);
}

function paint(e: Editor, keys: number[], layerId = e.activeLayerId) {
  return e.commitStroke(layerId, keys, 'paint');
}

describe('strokes', () => {
  it('allocates one new tile per touched key and records src/dst jobs', () => {
    const e = singleCanvasEditor(new TileStore(16));
    const jobs = paint(e, [0, 1])!;
    expect(jobs.map((j) => j.src)).toEqual([null, null]);
    expect(e.activeLayer.tiles.size).toBe(2);
    const second = paint(e, [1])!;
    expect(second[0]!.src).toBe(jobs[1]!.dst); // painting on an existing tile reads it…
    expect(second[0]!.dst).not.toBe(jobs[1]!.dst); // …and writes a new slot (copy-on-write)
  });

  it('paint stroke undo/redo swaps tiles', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0]);
    expectUndoable(e, () => paint(e, [0, 5]));
    expectNoLeaks(e);
  });

  it('eraser stroke undo/redo, skipping tiles that do not exist', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0, 1]);
    let jobs: ReturnType<Editor['commitStroke']> = null;
    expectUndoable(e, () => {
      jobs = e.commitStroke(e.activeLayerId, [1, 2, 3], 'erase');
    });
    expect(jobs!.map((j) => j.key)).toEqual([1]);
    expectNoLeaks(e);
  });

  it('erasing where there is nothing records no step', () => {
    const e = singleCanvasEditor(new TileStore(16));
    expect(e.commitStroke(e.activeLayerId, [4], 'erase')).toEqual([]);
    expect(e.history.undoCount).toBe(0);
  });

  it('a new stroke after undo discards the redo step and frees its tiles', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0]);
    paint(e, [1, 2]);
    e.undo();
    expect(e.store.usedSlots).toBe(3); // redo still holds tiles 1 and 2
    paint(e, [3]);
    expect(e.history.redoCount).toBe(0);
    expect(e.store.usedSlots).toBe(2);
    expectNoLeaks(e);
  });

  it('forgets tiles found empty, in the document and in history', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0]);
    const [job] = e.commitStroke(e.activeLayerId, [0], 'erase')!;
    const generation = e.store.generation(job!.dst);
    e.forgetEmptyTiles([{ slot: job!.dst, generation }]);
    expect(e.activeLayer.tiles.has(0)).toBe(false);
    expect(e.store.refCount(job!.dst)).toBe(0);
    e.undo(); // restores the painted tile
    expect(e.activeLayer.tiles.get(0)).toBe(job!.src);
    e.redo(); // back to "no tile", not to the freed slot
    expect(e.activeLayer.tiles.has(0)).toBe(false);
    expectNoLeaks(e);
  });

  it('ignores an empty-tile result for a slot that was reused since', () => {
    const e = singleCanvasEditor(new TileStore(16));
    const [job] = paint(e, [0])!;
    e.forgetEmptyTiles([{ slot: job!.dst, generation: e.store.generation(job!.dst) - 1 }]);
    expect(e.activeLayer.tiles.has(0)).toBe(true);
  });
});

describe('layer commands', () => {
  it('add layer: above the active layer, selected, undoable', () => {
    const e = singleCanvasEditor(new TileStore(16));
    const first = e.activeLayerId;
    expectUndoable(e, () => e.addLayer());
    expect(e.doc.layers.length).toBe(2);
    expect(e.doc.indexOf(e.activeLayerId)).toBe(1);
    e.undo();
    expect(e.activeLayerId).toBe(first);
  });

  it('enforces the layer limit', () => {
    const e = singleCanvasEditor(new TileStore(16));
    for (let i = 1; i < MAX_LAYERS; i++) expect(e.addLayer()).toBe(true);
    expect(e.addLayer()).toBe(false);
    expect(e.duplicateLayer(e.activeLayerId)).toBe(false);
  });

  it('delete layer: undoable, keeps tiles alive in history, cannot delete the last layer', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0, 1]);
    e.addLayer();
    const bottom = e.doc.layers[0]!.id;
    expectUndoable(e, () => e.deleteLayer(bottom));
    expect(e.store.usedSlots).toBe(2);
    expect(e.deleteLayer(e.doc.layers[0]!.id)).toBe(false);
    expectNoLeaks(e);
    expect(e.store.usedSlots).toBe(0); // deleted layer's tiles freed with its history
  });

  it('duplicate layer shares tiles without copying, and painting on the copy diverges', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0]);
    e.setLayerProps(e.activeLayerId, { opacity: 0.5 });
    const original = e.activeLayer;
    expectUndoable(e, () => e.duplicateLayer(original.id));
    const copy = e.activeLayer;
    expect(copy.id).not.toBe(original.id);
    expect(copy.opacity).toBe(0.5);
    expect(copy.tiles.get(0)).toBe(original.tiles.get(0));
    expect(e.store.usedSlots).toBe(1);
    paint(e, [0], copy.id);
    expect(copy.tiles.get(0)).not.toBe(original.tiles.get(0));
    expectNoLeaks(e);
  });

  it('move layer: undoable', () => {
    const e = singleCanvasEditor(new TileStore(16));
    e.addLayer();
    e.addLayer();
    const bottom = e.doc.layers[0]!.id;
    expectUndoable(e, () => e.moveLayer(bottom, 2));
    expect(e.doc.layers[2]!.id).toBe(bottom);
  });

  it('rename layer: undoable, ignores blank names', () => {
    const e = singleCanvasEditor(new TileStore(16));
    expectUndoable(e, () => e.renameLayer(e.activeLayerId, 'Sketch'));
    e.renameLayer(e.activeLayerId, '   ');
    expect(e.activeLayer.name).toBe('Sketch');
  });

  it.each([
    ['opacity', { opacity: 0.3 }],
    ['visibility', { visible: false }],
    ['blend mode', { blendMode: 'multiply' as const }],
  ])('set %s: undoable', (_name, props) => {
    const e = singleCanvasEditor(new TileStore(16));
    expectUndoable(e, () => e.setLayerProps(e.activeLayerId, props));
  });

  it('merges a slider drag into one undo step', () => {
    const e = singleCanvasEditor(new TileStore(16));
    for (const opacity of [0.9, 0.7, 0.5, 0.2]) e.setLayerProps(e.activeLayerId, { opacity }, 'drag-1');
    expect(e.history.undoCount).toBe(1);
    e.undo();
    expect(e.activeLayer.opacity).toBe(1);
    e.redo();
    expect(e.activeLayer.opacity).toBe(0.2);
    e.setLayerProps(e.activeLayerId, { opacity: 0.4 }, 'drag-2');
    expect(e.history.undoCount).toBe(2);
  });

  it('clear layer: undoable, tiles kept by history until dropped', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0, 1, 2]);
    expectUndoable(e, () => e.clearLayer(e.activeLayerId));
    expect(e.store.usedSlots).toBe(3);
    expectNoLeaks(e);
    expect(e.store.usedSlots).toBe(0);
  });

  it('paper colour: undoable, recomposites everything', () => {
    const e = singleCanvasEditor(new TileStore(16));
    const changes: unknown[] = [];
    e.onChange((c) => changes.push(c.tiles));
    expectUndoable(e, () => e.setPaper([0.9, 0.85, 0.7]));
    expect(changes.every((t) => t === 'all')).toBe(true);
  });
});

describe('history budget', () => {
  it('drops the oldest steps when history memory exceeds the budget', () => {
    const e = singleCanvasEditor(new TileStore(64), 2 * TILE_BYTES);
    paint(e, [0]);
    paint(e, [0]); // history now holds 1 superseded tile
    paint(e, [0]); // 2
    expect(e.history.undoCount).toBe(3);
    paint(e, [0]); // 3 > budget → oldest step dropped
    expect(e.historyBytes()).toBeLessThanOrEqual(2 * TILE_BYTES);
    expect(e.history.undoCount).toBeLessThan(4);
    // The remaining steps still undo correctly.
    while (e.undo()) {
      /* undo everything left */
    }
    expectNoLeaks(e);
  });

  it('drops history to make room when the tile pool is full, and refuses when that is not enough', () => {
    const e = singleCanvasEditor(new TileStore(3));
    paint(e, [0, 1]);
    paint(e, [0]); // 3 slots used, one held only by history
    expect(paint(e, [1])).not.toBeNull(); // needs 1 slot: drops history to get it
    expect(e.store.usedSlots).toBe(3);
    expect(paint(e, [2, 3, 4])).toBeNull(); // pool too small even with no history
  });

  it('reports history bytes as tiles not used by the document', () => {
    const e = singleCanvasEditor(new TileStore(16));
    paint(e, [0, 1]);
    expect(e.historyBytes()).toBe(0);
    paint(e, [0]);
    expect(e.historyBytes()).toBe(TILE_BYTES);
    e.undo();
    expect(e.historyBytes()).toBe(TILE_BYTES); // now the redo step holds the newer tile
  });
});
