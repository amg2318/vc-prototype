import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { inProcessClient } from './client';
import { FORMAT_VERSION, type CanvasRecord } from './format';
import { encodeJson, encodeObject } from './objectCodec';
import { StorageService } from './service';
import { MemoryBlobStore, MemoryCatalog } from './stores';

const tile = (value: number) => new Uint8Array(TILE_BYTES).fill(value);

function record(hash: string): CanvasRecord {
  return {
    formatVersion: FORMAT_VERSION, id: 'canvas-1', name: 'One', x: 0, y: 0, width: 256, height: 256, paper: [1, 1, 1], paperVisible: true,
    layerCounter: 1, layers: [{ id: 'canvas-1:layer-1', name: 'Layer 1', opacity: 1, visible: true, blendMode: 'normal', tiles: { '0,0': hash } }],
    inherited: null, previews: [],
  };
}

/** A project with a version (tile 1) and a different working copy (tile 2). */
async function setup() {
  const storage = inProcessClient(new StorageService(new MemoryBlobStore(), new MemoryCatalog()));
  const project = await storage.createProject('Sketches');
  await storage.openProject(project.id);
  const save = async (value: number) => {
    const [put] = await storage.putTiles([tile(value)]);
    return storage.commit({ canvases: [{ id: 'canvas-1', record: record(put!.hash) }], canvasCounter: 1, activeCanvasId: 'canvas-1' });
  };
  await save(1);
  await storage.updateHead(
    { versions: [{ id: 'v-1', manifestId: null, name: 'First', createdAt: 1, kind: 'manual', pinned: true, thumbnail: 'v-1.png' }] },
    { name: 'v-1.png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]) },
  );
  await save(2);
  return { storage, project };
}

/** The first tile's first byte of a project's working copy, or of its first version. */
async function firstByte(storage: Awaited<ReturnType<typeof setup>>['storage'], projectId: string, fromVersion = false) {
  const opened = await storage.openProject(projectId);
  const copy = (await storage.readProject(fromVersion ? opened.head!.versions[0]!.manifestId : null))!;
  return (await storage.getTile(copy.records[0]!.layers[0]!.tiles['0,0']!))[0];
}

describe('project files', () => {
  it('round-trip with history into a new project, with new ids', async () => {
    const { storage, project } = await setup();
    const file = await storage.exportProject(project.id, true);
    const imported = await storage.importProject(file);
    expect(imported.id).not.toBe(project.id);
    expect(imported.name).toBe('Sketches');
    expect(await firstByte(storage, imported.id)).toBe(2);
    expect(await firstByte(storage, imported.id, true)).toBe(1);
    const head = (await storage.openProject(imported.id)).head!;
    expect(head.versions[0]).toMatchObject({ name: 'First', pinned: true });
    expect(head.versions[0]!.id).not.toBe('v-1');
    expect(await storage.readThumbnail(head.versions[0]!.thumbnail!)).not.toBeNull();
    expect((await storage.listProjects()).length).toBe(2); // the original is untouched
    expect(await firstByte(storage, project.id)).toBe(2);
  });

  it('without history holds only the working copy', async () => {
    const { storage, project } = await setup();
    const file = await storage.exportProject(project.id, false);
    const names = Object.keys(unzipSync(file));
    expect(names.filter((n) => n.startsWith('tiles/'))).toHaveLength(1);
    const imported = await storage.importProject(file);
    expect((await storage.openProject(imported.id)).head!.versions).toEqual([]);
    expect(await firstByte(storage, imported.id)).toBe(2);
  });

  it('refuses a damaged tile, a missing tile, a newer format and a stranger file, writing nothing', async () => {
    const { storage, project } = await setup();
    const entries = unzipSync(await storage.exportProject(project.id, false));
    const tilePath = Object.keys(entries).find((n) => n.startsWith('tiles/'))!;

    const damaged = { ...entries, [tilePath]: entries[tilePath]!.map((b, i) => (i === 40 ? b ^ 1 : b)) };
    await expect(storage.importProject(zipSync(damaged))).rejects.toThrow();
    const missing = { ...entries };
    delete missing[tilePath];
    await expect(storage.importProject(zipSync(missing))).rejects.toThrow(/missing/);
    const index = JSON.parse(strFromU8(entries['project.json']!));
    const newer = { ...entries, 'project.json': strToU8(JSON.stringify({ ...index, formatVersion: FORMAT_VERSION + 1 })) };
    await expect(storage.importProject(zipSync(newer))).rejects.toThrow(/newer version/);
    await expect(storage.importProject(zipSync({ ...entries, '../escape': new Uint8Array(1) }))).rejects.toThrow(/Unexpected file/);
    await expect(storage.importProject(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a project file/);
    expect((await storage.listProjects()).length).toBe(1);
  });

  it('migrates an old-format file on import', async () => {
    const { storage } = await setup();
    const t = await encodeObject(tile(9));
    // Format 0: integer tile keys, "blend", no previews (see migrations.ts).
    const draft = {
      formatVersion: 0, id: 'canvas-1', name: 'Old', x: 0, y: 0, width: 256, height: 256, paper: [1, 1, 1], paperVisible: true, layerCounter: 1,
      layers: [{ id: 'canvas-1:layer-1', name: 'Layer 1', opacity: 1, visible: true, blend: 'normal', tiles: { '0': t.hash } }], inherited: null,
    };
    const r = await encodeJson(draft);
    const manifest = { id: 'm-old', createdAt: 1, canvases: [{ id: 'canvas-1', record: r.hash }], activeCanvasId: null };
    const index = { kind: 'vc-project', formatVersion: 0, exportedAt: 1, name: 'Old project', includesHistory: false, working: 'm-old', versions: [] };
    const file = zipSync({
      'project.json': strToU8(JSON.stringify(index)),
      'manifests/m-old.json': strToU8(JSON.stringify(manifest)),
      [`records/${r.hash}`]: r.bytes,
      [`tiles/${t.hash}`]: t.bytes,
    });
    const imported = await storage.importProject(file);
    await storage.openProject(imported.id);
    const copy = (await storage.readProject(null))!;
    expect(copy.manifest.formatVersion).toBe(FORMAT_VERSION);
    expect(copy.records[0]!.layers[0]!.blendMode).toBe('normal');
    expect(copy.manifest.canvases[0]!.record).not.toBe(r.hash); // re-stored in the current format
    expect((await storage.getTile(copy.records[0]!.layers[0]!.tiles['0,0']!))[0]).toBe(9);
  });
});
