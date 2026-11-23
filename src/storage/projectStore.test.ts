import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { FORMAT_VERSION, manifestPath, type CanvasRecord, type ProjectInfo } from './format';
import { ProjectStore, type CanvasEntry } from './projectStore';
import { MemoryBlobStore, MemoryCatalog, isQuotaError } from './stores';
import { CrashSwitch, SimulatedCrash, crashingBlobStore, crashingCatalog } from './testing';

function tile(value: number): Uint8Array {
  const rgba = new Uint8Array(TILE_BYTES);
  for (let i = 0; i < TILE_BYTES; i += 4) rgba.set([value, value >> 1, 0, value], i);
  return rgba;
}

function info(id = 'p-1'): ProjectInfo {
  return { id, name: 'Test', createdAt: 0, lastOpenedAt: 0, sizeBytes: 0 };
}

function record(id: string, tiles: Record<string, string>[]): CanvasRecord {
  return {
    formatVersion: FORMAT_VERSION,
    id,
    name: id,
    x: 0,
    y: 0,
    width: 1024,
    height: 1024,
    paper: [1, 1, 1],
    paperVisible: true,
    layerCounter: tiles.length,
    layers: tiles.map((t, i) => ({ id: `${id}:layer-${i + 1}`, name: `Layer ${i + 1}`, opacity: 1, visible: true, blendMode: 'normal', tiles: t })),
    inherited: null,
    previews: [],
  };
}

async function save(store: ProjectStore, canvases: CanvasEntry[]) {
  return store.commit({ canvases, canvasCounter: canvases.length, activeCanvasId: null });
}

/** Every tile and record the working copy uses can be read back. */
async function readWholeProject(store: ProjectStore): Promise<CanvasRecord[]> {
  const copy = await store.readWorkingCopy();
  if (!copy) throw new Error('no working copy');
  for (const r of copy.records) {
    for (const layer of r.layers) for (const hash of Object.values(layer.tiles)) await store.getTile(hash);
  }
  return copy.records;
}

describe('ProjectStore: objects', () => {
  it('stores identical tiles once, across layers, canvases and versions', async () => {
    const files = new MemoryBlobStore();
    const store = ProjectStore.create(info(), files, new MemoryCatalog());
    const a = (await store.putTile(tile(10)))!;
    const again = (await store.putTile(tile(10)))!;
    expect(again.hash).toBe(a.hash);
    expect(a.written).toBeGreaterThan(0);
    expect(again.written).toBe(0);

    // Two layers and two canvases share the tile; a second save shares it too.
    await save(store, [
      { id: 'c1', record: record('c1', [{ '0,0': a.hash }, { '1,0': a.hash }]) },
      { id: 'c2', record: record('c2', [{ '3,3': a.hash }]) },
    ]);
    expect((await store.putTile(tile(10)))!.written).toBe(0);
    const tileFiles = [...files.files.keys()].filter((p) => p.startsWith('tiles/'));
    expect(tileFiles).toHaveLength(1);
  });

  it('never stores an empty tile', async () => {
    const files = new MemoryBlobStore();
    const store = ProjectStore.create(info(), files, new MemoryCatalog());
    expect(await store.putTile(new Uint8Array(TILE_BYTES))).toBeNull();
    expect(files.files.size).toBe(0);
  });

  it('rewrites a torn tile file instead of trusting it', async () => {
    const files = new MemoryBlobStore();
    const first = ProjectStore.create(info(), files, new MemoryCatalog());
    const { hash } = (await first.putTile(tile(20)))!;
    const path = [...files.files.keys()][0]!;
    files.files.set(path, files.files.get(path)!.subarray(0, 100)); // as a crash would leave it

    const second = ProjectStore.create(info(), files, new MemoryCatalog()); // a new session
    expect((await second.putTile(tile(20)))!.written).toBeGreaterThan(0);
    expect(await second.getTile(hash)).toEqual(tile(20));
  });

  it('refuses to commit a manifest whose tiles are not on disk', async () => {
    const catalog = new MemoryCatalog();
    const store = ProjectStore.create(info(), new MemoryBlobStore(), catalog);
    await expect(save(store, [{ id: 'c1', record: record('c1', [{ '0,0': 'a'.repeat(64) }]) }])).rejects.toThrow(/missing/);
    expect(await catalog.head('p-1')).toBeNull();
  });
});

describe('ProjectStore: commit sequence', () => {
  it('writes records, then the manifest, then the head, and removes the old working manifest', async () => {
    const files = new MemoryBlobStore();
    const catalog = new MemoryCatalog();
    const store = ProjectStore.create(info(), files, catalog);
    const t = (await store.putTile(tile(1)))!;
    const first = await save(store, [{ id: 'c1', record: record('c1', [{ '0,0': t.hash }]) }]);
    const second = await save(store, [{ id: 'c1', hash: first.recordHashes.get('c1')! }]);

    expect((await catalog.head('p-1'))!.working).toBe(second.manifestId);
    expect(files.files.has(manifestPath(first.manifestId))).toBe(false);
    expect(files.files.has(manifestPath(second.manifestId))).toBe(true);
    // The unchanged canvas reused its record: only the manifest was written.
    expect(second.bytesWritten).toBe(files.files.get(manifestPath(second.manifestId))!.byteLength);
    expect((await catalog.project('p-1'))!.sizeBytes).toBe(files.bytesUsed);
  });

  it('keeps a manifest a version still uses', async () => {
    const files = new MemoryBlobStore();
    const store = ProjectStore.create(info(), files, new MemoryCatalog());
    const t = (await store.putTile(tile(1)))!;
    const first = await store.commit({
      canvases: [{ id: 'c1', record: record('c1', [{ '0,0': t.hash }]) }],
      canvasCounter: 1,
      activeCanvasId: null,
      editHead: (head, manifestId) => ({
        ...head,
        versions: [{ id: 'v-1', manifestId, name: 'v', createdAt: 0, kind: 'manual', pinned: false, thumbnail: null }],
      }),
    });
    await save(store, [{ id: 'c1', hash: first.recordHashes.get('c1')! }]);
    expect(files.files.has(manifestPath(first.manifestId))).toBe(true);
  });

  /**
   * The app may die at any step of a save. For every step, simulate dying
   * there, then "relaunch" on what is left on disk: the head must point to a
   * complete project, either the state before the save or after it, and the
   * next save must succeed.
   */
  it('leaves the head on a complete project whatever step the app dies at', async () => {
    async function run(crashAt: number): Promise<{ steps: number; crashed: boolean; files: MemoryBlobStore; catalog: MemoryCatalog }> {
      const files = new MemoryBlobStore();
      const catalog = new MemoryCatalog();
      // State A, saved without crashing.
      const setup = ProjectStore.create(info(), files, catalog);
      const a = (await setup.putTile(tile(1)))!;
      await save(setup, [
        { id: 'c1', record: record('c1', [{ '0,0': a.hash }]) },
        { id: 'c2', record: record('c2', [{ '0,0': a.hash }]) },
      ]);

      // State B: a new tile on c1, c2 deleted, a new canvas c3, saved by a session that may die.
      const crash = new CrashSwitch(crashAt);
      const session = await ProjectStore.open('p-1', crashingBlobStore(files, crash), crashingCatalog(catalog, crash));
      let crashed = false;
      try {
        const b = (await session.putTile(tile(2)))!;
        const c = (await session.putTile(tile(3)))!;
        await save(session, [
          { id: 'c1', record: record('c1', [{ '0,0': a.hash, '1,0': b.hash }]) },
          { id: 'c3', record: record('c3', [{ '2,2': c.hash }]) },
        ]);
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        crashed = true;
      }
      return { steps: crash.steps, crashed, files, catalog };
    }

    const { steps } = await run(Infinity);
    expect(steps).toBeGreaterThanOrEqual(5); // 2 tiles, 2 records, manifest, head, clean-up

    for (let crashAt = 0; crashAt <= steps; crashAt++) {
      const { crashed, files, catalog } = await run(crashAt);
      expect(crashed).toBe(crashAt < steps);

      const relaunched = await ProjectStore.open('p-1', files, catalog);
      const records = await readWholeProject(relaunched);
      const ids = records.map((r) => r.id).join(',');
      expect(['c1,c2', 'c1,c3']).toContain(ids);

      // Saving again after the crash works, and repairs torn files.
      const b = (await relaunched.putTile(tile(2)))!;
      await save(relaunched, [{ id: 'c1', record: record('c1', [{ '1,0': b.hash }]) }]);
      const after = await readWholeProject(relaunched);
      expect(after.map((r) => r.id)).toEqual(['c1']);
      expect(await relaunched.getTile(b.hash)).toEqual(tile(2));
    }
  });
});

describe('ProjectStore: running out of space', () => {
  it('a save that hits the quota leaves the head on the last complete save', async () => {
    const files = new MemoryBlobStore();
    const catalog = new MemoryCatalog();
    const store = ProjectStore.create(info(), files, catalog);
    const a = (await store.putTile(tile(1)))!;
    const first = await save(store, [{ id: 'c1', record: record('c1', [{ '0,0': a.hash }]) }]);

    files.quotaBytes = files.bytesUsed + 200; // room for a manifest, not for a tile
    const error = await store.putTile(tile(2)).catch((e: unknown) => e);
    expect(isQuotaError(error)).toBe(true);
    expect((await catalog.head('p-1'))!.working).toBe(first.manifestId);

    // Once there is room again, saving continues.
    files.quotaBytes = Infinity;
    const b = (await store.putTile(tile(2)))!;
    await save(store, [{ id: 'c1', record: record('c1', [{ '0,0': b.hash }]) }]);
    expect(await readWholeProject(store)).toHaveLength(1);
  });
});
