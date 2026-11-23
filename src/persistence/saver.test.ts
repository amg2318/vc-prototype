import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileStore } from '../document/tileStore';
import { tileKey, type TileId } from '../document/tiles';
import { inProcessClient } from '../storage/client';
import { StorageService } from '../storage/service';
import { MemoryBlobStore, MemoryCatalog } from '../storage/stores';
import { Workspace } from '../workspace/workspace';
import { ProjectSaver } from './saver';
import { TileHashes } from './tileHashes';

/**
 * A workspace, storage in memory, and a stand-in for the GPU: each tile id's
 * "pixels" are a tile filled with a value chosen by the test.
 */
async function setup() {
  const store = new TileStore(256);
  const workspace = new Workspace(store);
  const doc = workspace.newCanvas({ width: 1024, height: 1024 }, 'One');
  workspace.attachCanvas(doc);
  const hashes = new TileHashes(store);
  const files = new MemoryBlobStore();
  const storage = inProcessClient(new StorageService(files, new MemoryCatalog()));
  await storage.openProject((await storage.createProject('Test')).id);
  const pixels = new Map<TileId, number>();
  const reads: TileId[][] = [];
  /** What the renderer answers for previews: one level-4 tile, or null (not ready). */
  const preview = { ready: true, value: 4 };
  const saver = new ProjectSaver({
    workspace,
    hashes,
    storage,
    readLayerTiles: async (ids) => {
      reads.push([...ids]);
      return ids.map((id) => (store.refCount(id) > 0 ? new Uint8Array(TILE_BYTES).fill(pixels.get(id) ?? 0) : null));
    },
    readPreviewTiles: async () => (preview.ready ? [{ level: 4, key: 0, rgba: new Uint8Array(TILE_BYTES).fill(preview.value) }] : null),
    view: () => undefined,
  });
  /** A stroke over `keys` whose new tiles get the pixel value `value`. */
  const stroke = (keys: number[], value: number, canvasId = doc.id) => {
    const editor = workspace.editor(canvasId);
    for (const job of editor.commitStroke(editor.activeLayerId, keys, 'paint')!) pixels.set(job.dst, value);
  };
  return { workspace, doc, hashes, files, storage, saver, stroke, reads, preview };
}

describe('ProjectSaver', () => {
  it('saves the canvases so they read back the same', async () => {
    const { saver, stroke, storage, doc } = await setup();
    stroke([tileKey(0, 0), tileKey(1, 0)], 7);
    const stats = await saver.save();
    expect(stats.committed).toBe(true);
    expect(stats.tilesWritten).toBe(2); // both layer tiles have the same pixels (stored once), plus one preview tile

    const saved = (await storage.readProject(null))!;
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]!.name).toBe(doc.name);
    const tiles = saved.records[0]!.layers[0]!.tiles;
    expect(Object.keys(tiles).sort()).toEqual(['0,0', '1,0']);
    expect(await storage.getTile(tiles['0,0']!)).toEqual(new Uint8Array(TILE_BYTES).fill(7));
  });

  it('reads back only tiles that have not been saved before', async () => {
    const { saver, stroke, reads } = await setup();
    stroke([tileKey(0, 0)], 1);
    await saver.save();
    stroke([tileKey(2, 2)], 2);
    await saver.save();
    expect(reads.map((r) => r.length)).toEqual([1, 1]);
  });

  it('writes only the records of canvases that changed', async () => {
    const { saver, stroke, workspace } = await setup();
    const second = workspace.createCanvas({ width: 512, height: 512 }, { x: 2000, y: 0 }, 'Two');
    stroke([tileKey(0, 0)], 1);
    stroke([tileKey(0, 0)], 2, second.id);
    expect((await saver.save()).recordsWritten).toBe(2);
    stroke([tileKey(1, 1)], 3, second.id);
    expect((await saver.save()).recordsWritten).toBe(1);
    workspace.renameCanvas(second.id, 'Renamed');
    expect((await saver.save()).recordsWritten).toBe(1);
  });

  it('makes no commit when nothing changed', async () => {
    const { saver, stroke } = await setup();
    stroke([tileKey(0, 0)], 1);
    await saver.save();
    expect((await saver.save()).committed).toBe(false);
  });

  it('saves non-stroke changes: layers, canvas order, arrows', async () => {
    const { saver, workspace, doc, storage } = await setup();
    await saver.save();
    const other = workspace.createCanvas({ width: 512, height: 512 }, { x: 2000, y: 0 }, 'Two');
    workspace.editor(doc.id).addLayer();
    workspace.connect(other.id, doc.id);
    workspace.bringToFront(doc.id);
    await saver.save();
    const saved = (await storage.readProject(null))!;
    expect(saved.manifest.canvases.map((c) => c.id)).toEqual([other.id, doc.id]);
    expect(saved.records.find((r) => r.id === doc.id)!.layers).toHaveLength(2);
    expect(saved.records.find((r) => r.id === other.id)!.inherited?.source).toEqual({ kind: 'linked', canvasId: doc.id });
  });

  it('leaves empty tiles out of the saved record', async () => {
    const { saver, stroke, storage } = await setup();
    stroke([tileKey(0, 0)], 0); // erased to nothing
    stroke([tileKey(1, 0)], 5);
    await saver.save();
    const saved = (await storage.readProject(null))!;
    expect(Object.keys(saved.records[0]!.layers[0]!.tiles)).toEqual(['1,0']);
  });

  it('saves previews with the record, and keeps the previous ones while new ones are not ready', async () => {
    const { saver, stroke, storage, doc, preview } = await setup();
    stroke([tileKey(0, 0)], 1);
    await saver.save();
    const first = (await storage.readProject(null))!.records[0]!.previews;
    expect(first).toEqual([{ level: 4, tiles: { '0,0': expect.stringMatching(/^[0-9a-f]{64}$/) } }]);

    // The composite changed, but its previews aren't rebuilt yet: keep the old ones, try again later.
    preview.ready = false;
    saver.previewsDirty.add(doc.id);
    stroke([tileKey(1, 1)], 2);
    await saver.save();
    expect((await storage.readProject(null))!.records[0]!.previews).toEqual(first);
    expect(saver.previewsDirty.has(doc.id)).toBe(true);

    preview.ready = true;
    preview.value = 9;
    await saver.save();
    expect((await storage.readProject(null))!.records[0]!.previews).not.toEqual(first);
    expect(saver.previewsDirty.size).toBe(0);
  });
});
