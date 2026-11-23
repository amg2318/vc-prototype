import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { inProcessClient } from './client';
import { FORMAT_VERSION, objectPath, type CanvasRecord } from './format';
import { StorageService } from './service';
import { MemoryBlobStore, MemoryCatalog } from './stores';

const tile = (value: number) => new Uint8Array(TILE_BYTES).fill(value);

function record(hashes: string[]): CanvasRecord {
  return {
    formatVersion: FORMAT_VERSION, id: 'canvas-1', name: 'One', x: 0, y: 0, width: 1024, height: 256, paper: [1, 1, 1], paperVisible: true,
    layerCounter: 1,
    layers: [{ id: 'canvas-1:layer-1', name: 'Layer 1', opacity: 1, visible: true, blendMode: 'normal', tiles: Object.fromEntries(hashes.map((h, i) => [`${i},0`, h])) }],
    inherited: null, previews: [],
  };
}

async function setup() {
  const files = new MemoryBlobStore();
  const catalog = new MemoryCatalog();
  const storage = inProcessClient(new StorageService(files, catalog));
  const project = await storage.createProject('P');
  await storage.openProject(project.id);
  const put = async (value: number) => (await storage.putTiles([tile(value)]))[0]!.hash;
  const save = (hashes: string[]) => storage.commit({ canvases: [{ id: 'canvas-1', record: record(hashes) }], canvasCounter: 1, activeCanvasId: null });
  const tileStored = (hash: string) => files.files.has(`projects/${project.id}/${objectPath('tile', hash)}`);
  /** The whole collection, sweeping in tiny steps. */
  const collect = async (live: string[] = []) => {
    await storage.gcBegin();
    await storage.gcMark(live);
    let steps = 0;
    while (!(await storage.gcSweep(0)).done) steps++;
    return { steps, size: await storage.gcFinish() };
  };
  return { files, catalog, storage, project, put, save, tileStored, collect };
}

describe('garbage collection', () => {
  it('removes tiles nothing refers to, and keeps the working copy, versions and live tiles', async () => {
    const { storage, put, save, tileStored, collect } = await setup();
    const [a, b, c, d] = [await put(1), await put(2), await put(3), await put(4)];
    await save([a]);
    await storage.updateHead({ versions: [{ id: 'v1', manifestId: null, name: 'v1', createdAt: 1, kind: 'manual', pinned: false, thumbnail: null }] });
    await save([b]); // the version still holds a
    // c: only in undo history (live in the app); d: nothing.
    await collect([c]);
    expect([a, b, c, d].map(tileStored)).toEqual([true, true, true, false]);

    // Deleting the version frees a.
    await storage.updateHead({ versions: [] });
    await collect();
    expect([a, b, c].map(tileStored)).toEqual([false, true, false]);
  });

  it('never removes what is written while it runs', async () => {
    const { storage, put, tileStored } = await setup();
    await storage.gcBegin();
    await storage.gcMark([]);
    const fresh = await put(7); // a stroke saved mid-collection, not committed yet
    while (!(await storage.gcSweep(0)).done);
    await storage.gcFinish();
    expect(tileStored(fresh)).toBe(true);
  });

  it('works in many small steps, and can be stopped half-way without losing anything in use', async () => {
    const { storage, put, save, tileStored, collect } = await setup();
    const used = [await put(1), await put(2)];
    await save(used);
    for (let i = 10; i < 20; i++) await put(i); // garbage
    await storage.gcBegin();
    await storage.gcMark([]);
    await storage.gcSweep(0);
    await storage.gcCancel(); // stopped
    expect(used.every(tileStored)).toBe(true);
    expect((await storage.readProject(null))!.records).toHaveLength(1);

    const { steps } = await collect();
    expect(steps).toBeGreaterThan(1);
    expect(used.every(tileStored)).toBe(true);
  });

  it('removes manifests and thumbnails left over from a crash, and recounts the size', async () => {
    const { storage, files, catalog, project, put, save, collect } = await setup();
    await save([await put(1)]);
    const folder = `projects/${project.id}/`;
    files.files.set(`${folder}manifests/m-orphan.json`, new Uint8Array(10));
    files.files.set(`${folder}thumbnails/v-orphan.png`, new Uint8Array(10));
    const { size } = await collect();
    expect(files.files.has(`${folder}manifests/m-orphan.json`)).toBe(false);
    expect(files.files.has(`${folder}thumbnails/v-orphan.png`)).toBe(false);
    const onDisk = [...files.files].filter(([k]) => k.startsWith(folder)).reduce((n, [, v]) => n + v.byteLength, 0);
    expect(size).toBe(onDisk);
    expect((await catalog.project(project.id))!.sizeBytes).toBe(onDisk);
    void storage;
  });

  it('a tile removed by one collection is written again when it is needed again', async () => {
    const { put, save, tileStored, collect } = await setup();
    const a = await put(1);
    await collect(); // a was never committed or live: removed
    expect(tileStored(a)).toBe(false);
    expect(await put(1)).toBe(a); // not "already stored"
    expect(tileStored(a)).toBe(true);
    await save([a]);
  });
});
