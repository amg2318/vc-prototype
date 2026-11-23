import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { inProcessClient } from './client';
import { FORMAT_VERSION, type CanvasRecord } from './format';
import { StorageService } from './service';
import { MemoryBlobStore, MemoryCatalog } from './stores';

function tile(value: number): Uint8Array {
  return new Uint8Array(TILE_BYTES).fill(value);
}

function record(id: string, hash: string): CanvasRecord {
  return {
    formatVersion: FORMAT_VERSION, id, name: id, x: 0, y: 0, width: 256, height: 256, paper: [1, 1, 1], paperVisible: true,
    layerCounter: 1, layers: [{ id: `${id}:layer-1`, name: 'Layer 1', opacity: 1, visible: true, blendMode: 'normal', tiles: { '0,0': hash } }],
    inherited: null, previews: [],
  };
}

function setup() {
  const files = new MemoryBlobStore();
  const catalog = new MemoryCatalog();
  return { files, catalog, storage: inProcessClient(new StorageService(files, catalog)) };
}

async function saveOneCanvas(storage: ReturnType<typeof setup>['storage'], value: number) {
  const [put] = await storage.putTiles([tile(value)]);
  return storage.commit({ canvases: [{ id: 'canvas-1', record: record('canvas-1', put!.hash) }], canvasCounter: 1, activeCanvasId: 'canvas-1' });
}

describe('StorageService', () => {
  it('creates, saves, reopens and reads a project', async () => {
    const { storage } = setup();
    const project = await storage.createProject('Sketches');
    await storage.openProject(project.id);
    await saveOneCanvas(storage, 7);
    await storage.closeProject();

    const opened = await storage.openProject(project.id);
    expect(opened.head).not.toBeNull();
    const copy = (await storage.readProject(null))!;
    expect(copy.records[0]!.name).toBe('canvas-1');
    expect(await storage.getTile(copy.records[0]!.layers[0]!.tiles['0,0']!)).toEqual(tile(7));
  });

  it('adds a version pointing at the manifest a commit writes', async () => {
    const { storage } = setup();
    await storage.openProject((await storage.createProject('P')).id);
    const [put] = await storage.putTiles([tile(1)]);
    const reply = await storage.commit({
      canvases: [{ id: 'canvas-1', record: record('canvas-1', put!.hash) }],
      canvasCounter: 1,
      activeCanvasId: null,
      head: { versions: [{ id: 'v-1', manifestId: null, name: 'First', createdAt: 1, kind: 'manual', pinned: false, thumbnail: null }] },
    });
    expect(reply.head.versions[0]!.manifestId).toBe(reply.manifestId);
  });

  it('duplicates a project into a new one with the same content', async () => {
    const { storage } = setup();
    const original = await storage.createProject('Original');
    await storage.openProject(original.id);
    await saveOneCanvas(storage, 3);
    const copy = await storage.duplicateProject(original.id, 'Original copy');
    expect(copy.id).not.toBe(original.id);
    expect(copy.sizeBytes).toBeGreaterThan(0);

    await storage.openProject(copy.id);
    const read = (await storage.readProject(null))!;
    expect(await storage.getTile(read.records[0]!.layers[0]!.tiles['0,0']!)).toEqual(tile(3));
  });

  it('deletes a project and its folder, leaving the others', async () => {
    const { storage, files } = setup();
    const a = await storage.createProject('A');
    const b = await storage.createProject('B');
    for (const p of [a, b]) {
      await storage.openProject(p.id);
      await saveOneCanvas(storage, 5);
    }
    await storage.deleteProject(a.id);
    expect((await storage.listProjects()).map((p) => p.name)).toEqual(['B']);
    expect([...files.files.keys()].some((path) => path.includes(a.id))).toBe(false);
    expect([...files.files.keys()].some((path) => path.includes(b.id))).toBe(true);
  });

  it('renames a project', async () => {
    const { storage } = setup();
    const p = await storage.createProject('Old');
    await storage.renameProject(p.id, 'New');
    expect((await storage.listProjects())[0]!.name).toBe('New');
  });
});
