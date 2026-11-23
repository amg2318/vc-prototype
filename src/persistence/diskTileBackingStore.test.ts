import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import { TileStore } from '../document/tileStore';
import { TileResidency } from '../render/residency';
import { inProcessClient } from '../storage/client';
import { StorageService } from '../storage/service';
import { MemoryBlobStore, MemoryCatalog } from '../storage/stores';
import { DiskTileBackingStore } from './diskTileBackingStore';
import { TileHashes } from './tileHashes';

async function setup(quotaBytes = Infinity) {
  const store = new TileStore(16);
  const hashes = new TileHashes(store);
  const files = new MemoryBlobStore(quotaBytes);
  const storage = inProcessClient(new StorageService(files, new MemoryCatalog()));
  await storage.openProject((await storage.createProject('P')).id);
  const backing = new DiskTileBackingStore(storage, hashes, store);
  return { store, hashes, files, storage, backing };
}

const tile = (v: number) => new Uint8Array(TILE_BYTES).fill(v);

describe('DiskTileBackingStore', () => {
  it('writes an evicted tile to disk and reads it back byte-identical', async () => {
    const { store, hashes, files, backing } = await setup();
    const id = store.allocate()!;
    await backing.put(id, tile(42));
    expect(hashes.get(id)).toMatch(/^[0-9a-f]{64}$/);
    expect([...files.files.keys()].some((p) => p.includes('/tiles/'))).toBe(true);
    expect(backing.stats().bytes).toBe(0); // nothing kept in memory
    expect(await backing.get(id)).toEqual(tile(42));
    expect(backing.isPersisted(id)).toBe(true);
  });

  it('falls back to memory when the disk is full, and still returns the pixels', async () => {
    const { store, backing } = await setup(100);
    const errors: unknown[] = [];
    backing.onWriteError = (e) => errors.push(e);
    const id = store.allocate()!;
    await backing.put(id, tile(7));
    expect(errors).toHaveLength(1);
    expect(backing.isPersisted(id)).toBe(false);
    expect(backing.stats().tiles).toBe(1);
    expect(await backing.get(id)).toEqual(tile(7));
  });

  it('lets residency drop a tile that is already on disk without reading it back', async () => {
    const { store, hashes, backing } = await setup();
    const residency = new TileResidency(1, backing);
    const a = store.allocate()!;
    const b = store.allocate()!;
    hashes.set(a, 'a'.repeat(64)); // saved earlier
    residency.place(a);
    residency.beginFrame();
    const placed = residency.place(b)!;
    expect(placed.evicted?.id).toBe(a);
    expect(placed.evicted?.needsReadback).toBe(false);
  });

  it('loads adopted tiles (only on disk) the first time they are needed', async () => {
    const { store, hashes, storage, backing } = await setup();
    const saved = store.allocate()!;
    await backing.put(saved, tile(3));
    const hash = hashes.get(saved)!;
    // A "reopened" project: a new id for the same content, known only by its hash.
    const fresh = new TileStore(16);
    const freshHashes = new TileHashes(fresh);
    const reopened = new DiskTileBackingStore(storage, freshHashes, fresh);
    const adopted = freshHashes.adopt(hash)!;
    const residency = new TileResidency(4, reopened);
    residency.adoptStored([adopted.id]);
    expect(residency.ensure([adopted.id])).toBe(false); // starts loading
    await new Promise((r) => setTimeout(r, 10));
    const [upload] = residency.takeUploads(4);
    expect(upload?.rgba).toEqual(tile(3));
  });
});
