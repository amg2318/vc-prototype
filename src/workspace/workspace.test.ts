import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileStore } from '../document/tileStore';
import { Workspace } from './workspace';

function twoCanvases() {
  const ws = new Workspace(new TileStore(32));
  const a = ws.newCanvas({ width: 1024, height: 1024 });
  const b = ws.newCanvas({ width: 512, height: 512 });
  ws.attachCanvas(a);
  ws.attachCanvas(b);
  return { ws, a, b, ea: ws.editor(a.id), eb: ws.editor(b.id) };
}

describe('Workspace', () => {
  it('gives every canvas its own id, name and first layer', () => {
    const { a, b } = twoCanvases();
    expect(a.id).not.toBe(b.id);
    expect([a.name, b.name]).toEqual(['Canvas 1', 'Canvas 2']);
    expect(a.layers).toHaveLength(1);
    expect(a.layers[0]!.id.startsWith(a.id)).toBe(true);
  });

  it('keeps one undo history across canvases, undone in time order', () => {
    const { ws, a, b, ea, eb } = twoCanvases();
    ea.commitStroke(ea.activeLayerId, [0], 'paint');
    eb.commitStroke(eb.activeLayerId, [1, 2], 'paint');
    expect(ws.history.undoCount).toBe(2);

    expect(ws.undo()?.canvasId).toBe(b.id);
    expect(b.layers[0]!.tiles.size).toBe(0);
    expect(a.layers[0]!.tiles.size).toBe(1);
    expect(ws.undo()?.canvasId).toBe(a.id);
    expect(ws.redo()?.canvasId).toBe(a.id);
    expect(a.layers[0]!.tiles.size).toBe(1);
  });

  it('counts history memory across all canvases', () => {
    const { ws, ea, eb } = twoCanvases();
    ea.commitStroke(ea.activeLayerId, [0], 'paint');
    eb.commitStroke(eb.activeLayerId, [0], 'paint');
    expect(ws.historyBytes()).toBe(0); // every tile is still in use
    ea.commitStroke(ea.activeLayerId, [0], 'paint'); // replaces a's tile; the old one lives in history
    expect(ws.historyBytes()).toBe(TILE_BYTES);
    expect(ea.historyBytes()).toBe(ws.historyBytes());
  });

  it('routes active-layer bookkeeping to the right canvas', () => {
    const { ws, ea, eb } = twoCanvases();
    eb.addLayer();
    const added = eb.activeLayerId;
    ea.addLayer();
    ws.undo(); // a's layer
    ws.undo(); // b's layer
    expect(eb.doc.hasLayer(added)).toBe(false);
    expect(eb.doc.hasLayer(eb.activeLayerId)).toBe(true);
    expect(ea.doc.hasLayer(ea.activeLayerId)).toBe(true);
  });

  it('keeps detached canvases findable by id until forgotten', () => {
    const { ws, a } = twoCanvases();
    ws.activeCanvasId = a.id;
    const index = ws.detachCanvas(a.id);
    expect(index).toBe(0);
    expect(ws.hasCanvas(a.id)).toBe(false);
    expect(ws.canvas(a.id)).toBe(a);
    expect(ws.activeCanvasId).toBeNull();
    ws.attachCanvas(a, index);
    expect(ws.canvases[0]).toBe(a);
    ws.detachCanvas(a.id);
    ws.forgetCanvas(a.id);
    expect(() => ws.canvas(a.id)).toThrow();
  });

  it('forgets empty tiles in every canvas that shares them', () => {
    const { ws, a, b, ea } = twoCanvases();
    const [job] = ea.commitStroke(ea.activeLayerId, [3], 'paint')!;
    // b shares the tile (as a duplicated canvas will in step 2)
    ws.store.retain(job!.dst);
    b.layers[0]!.tiles.set(3, job!.dst);
    ws.forgetEmptyTiles([{ slot: job!.dst, generation: ws.store.generation(job!.dst) }]);
    expect(a.layers[0]!.tiles.has(3)).toBe(false);
    expect(b.layers[0]!.tiles.has(3)).toBe(false);
  });
});
