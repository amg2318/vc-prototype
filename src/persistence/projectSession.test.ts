import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileStore } from '../document/tileStore';
import { tileKey, type TileId } from '../document/tiles';
import type { Renderer } from '../render/renderer';
import { inProcessClient } from '../storage/client';
import { StorageService } from '../storage/service';
import { MemoryBlobStore, MemoryCatalog } from '../storage/stores';
import { Workspace } from '../workspace/workspace';
import { ProjectSession } from './projectSession';

/**
 * The session with storage in memory and a stand-in renderer whose "GPU"
 * holds, for each tile id, a tile filled with a value the test chose.
 * Browser globals the session touches are stubbed.
 */
async function setup() {
  const store = new TileStore(256);
  const workspace = new Workspace(store);
  const storage = inProcessClient(new StorageService(new MemoryBlobStore(), new MemoryCatalog()));
  const pixels = new Map<TileId, number>();
  const renderer = {
    useBackingStore() {},
    onCompositeChanged: null,
    readLayerTiles: async (ids: readonly TileId[]) => ids.map((id) => (store.refCount(id) > 0 ? new Uint8Array(TILE_BYTES).fill(pixels.get(id) ?? 0) : null)),
    readPreviewTiles: async () => [],
    seedPreviews: () => true,
    adoptStoredTiles() {},
  } as unknown as Renderer;
  const session = new ProjectSession({
    workspace,
    renderer,
    storage,
    view: () => undefined,
    newProjectCanvases: (ws) => [ws.newCanvas({ width: 512, height: 512 }, 'One')],
  });
  await session.create('Test');
  const stroke = (value: number) => {
    const editor = workspace.editor(workspace.canvases[0]!.id);
    for (const job of editor.commitStroke(editor.activeLayerId, [tileKey(0, 0)], 'paint')!) pixels.set(job.dst, value);
  };
  /** The value of the first tile of the first canvas as saved in the working copy. */
  const savedValue = async () => {
    const copy = (await storage.readProject(null))!;
    const hash = copy.records[0]!.layers[0]!.tiles['0,0'];
    return hash ? (await storage.getTile(hash))[0] : null;
  };
  return { workspace, session, stroke, savedValue, pixels };
}

describe('ProjectSession versions', () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('localStorage', { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a manual version keeps the state it was made in', async () => {
    const { session, stroke, savedValue } = await setup();
    stroke(5);
    const version = (await session.saveVersion('manual'))!;
    expect(version.kind).toBe('manual');
    stroke(9);
    await session.saveNow();
    expect(await savedValue()).toBe(9);
    expect(session.versions.map((v) => v.id)).toEqual([version.id]);
  });

  it('an automatic version of an unchanged project is skipped', async () => {
    const { session, stroke } = await setup();
    stroke(5);
    await session.saveVersion('manual');
    expect(await session.saveVersion('auto', 'active-time')).toBeNull();
  });

  it('restore brings the version back, keeps the replaced state as "Before restore", and clears undo', async () => {
    const { session, stroke, savedValue, workspace } = await setup();
    stroke(5);
    const first = (await session.saveVersion('manual'))!;
    stroke(9);
    expect(workspace.history.canUndo).toBe(true);

    const before = await session.restoreVersion(first);
    expect(before?.reason).toBe('before-restore');
    expect(await savedValue()).toBe(5); // the working copy is the restored state
    expect(workspace.history.canUndo).toBe(false);

    // The replaced state is still there, and restoring it brings the 9 back.
    await session.restoreVersion(before!);
    expect(await savedValue()).toBe(9);
  });

  it('garbage collection keeps tiles only the undo history holds, so undo saves again afterwards', async () => {
    const { session, stroke, savedValue, workspace } = await setup();
    stroke(5);
    await session.saveNow();
    stroke(9); // replaces the tile: the 5 is now only in undo history
    await session.saveNow();
    const stats = (await session.collectGarbage())!;
    expect(stats.removedFiles).toBeGreaterThan(0); // the old working manifest's leftovers, at least

    workspace.history.undo();
    await session.saveNow();
    expect(await savedValue()).toBe(5);
  });

  it('duplicates a project with its content, and deleting the open project opens another', async () => {
    const { session, stroke, savedValue } = await setup();
    stroke(5);
    await session.saveVersion('manual');
    const original = session.project!;
    const copy = await session.duplicateProject(original.id, 'Copy');
    expect(session.project!.id).toBe(original.id); // the copy isn't opened

    const result = await session.deleteProject(original.id);
    expect(result.reopened).toBe(true);
    expect(session.project!.id).toBe(copy.id);
    expect(await savedValue()).toBe(5);
    expect(session.versions).toHaveLength(1);
    expect((await session.listProjects()).map((p) => p.name)).toEqual(['Copy']);
  });
});
