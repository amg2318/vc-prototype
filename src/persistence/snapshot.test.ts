import { describe, expect, it } from 'vitest';
import { TileStore } from '../document/tileStore';
import { tileKey } from '../document/tiles';
import { Workspace } from '../workspace/workspace';
import { canvasFromRecord, canvasRecord, unhashedTiles } from './snapshot';
import { TileHashes } from './tileHashes';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function paintedWorkspace() {
  const store = new TileStore(64);
  const hashes = new TileHashes(store);
  const ws = new Workspace(store);
  const doc = ws.newCanvas({ width: 1024, height: 512 }, 'Sketch');
  ws.attachCanvas(doc);
  const editor = ws.editor(doc.id);
  editor.commitStroke(doc.layers[0]!.id, [tileKey(0, 0), tileKey(3, 1)], 'paint');
  return { store, hashes, ws, doc };
}

describe('snapshot', () => {
  it('lists the tiles that still need saving', () => {
    const { hashes, doc } = paintedWorkspace();
    const ids = [...doc.layers[0]!.tiles.values()];
    expect(unhashedTiles([doc], hashes)).toEqual(new Set(ids));
    hashes.set(ids[0]!, H1);
    expect(unhashedTiles([doc], hashes)).toEqual(new Set([ids[1]]));
  });

  it('round-trips a canvas through its record, leaving out empty tiles', () => {
    const { store, hashes, doc } = paintedWorkspace();
    const [a, b] = [...doc.layers[0]!.tiles.values()];
    hashes.set(a!, H1);
    hashes.set(b!, null); // erased to nothing
    doc.paper = [0.9, 0.8, 0.7];
    doc.layers[0]!.opacity = 0.4;
    const record = canvasRecord(doc, hashes, []);
    expect(record.layers[0]!.tiles).toEqual({ '0,0': H1 });

    const fresh: number[] = [];
    const loaded = canvasFromRecord(record, store, hashes, (id) => fresh.push(id))!;
    expect(loaded.name).toBe('Sketch');
    expect(loaded.paper).toEqual([0.9, 0.8, 0.7]);
    expect(loaded.layers[0]!.id).toBe(doc.layers[0]!.id);
    expect(loaded.layers[0]!.opacity).toBe(0.4);
    // The tile still in memory is shared, not loaded again.
    expect(loaded.layers[0]!.tiles.get(tileKey(0, 0))).toBe(a);
    expect(fresh).toEqual([]);
    expect(canvasRecord(loaded, hashes, [])).toEqual(record);
  });

  it('gives content not in memory one new id per hash, shared between layers', () => {
    const store = new TileStore(64);
    const hashes = new TileHashes(store);
    const { doc, hashes: other } = paintedWorkspace();
    for (const id of doc.layers[0]!.tiles.values()) other.set(id, H2);
    const record = canvasRecord(doc, other, []);
    record.layers.push({ ...record.layers[0]!, id: 'second' });

    const fresh: number[] = [];
    const loaded = canvasFromRecord(record, store, hashes, (id) => fresh.push(id))!;
    expect(fresh).toHaveLength(1);
    expect(store.refCount(fresh[0]!)).toBe(4); // two tiles in each of two layers
    expect(hashes.get(fresh[0]!)).toBe(H2);
    expect(loaded.layers).toHaveLength(2);
  });

  it('Workspace.load replaces the canvases, clears history and frees the old tiles', () => {
    const { store, ws } = paintedWorkspace();
    expect(ws.history.canUndo).toBe(true);
    const replacement = ws.newCanvas({ width: 256, height: 256 }, 'New');
    ws.load([replacement], 7, null);
    expect(ws.canvases.map((c) => c.name)).toEqual(['New']);
    expect(ws.history.canUndo).toBe(false);
    expect(store.usedSlots).toBe(0);
    expect(ws.activeCanvasId).toBe(replacement.id);
    expect(ws.newCanvas({ width: 1, height: 1 }).id).toBe('canvas-8');
  });
});
