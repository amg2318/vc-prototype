/// <reference lib="webworker" />
import { IdbCatalog } from './idbCatalog';
import { OpfsBlobStore } from './opfsBlobStore';
import { StorageService, type StorageOp } from './service';
import { MemoryBlobStore, MemoryCatalog } from './stores';

/**
 * The storage worker: every disk read and write, hashing and compression
 * happen here, off the main thread, so saving never costs the drawing loop a
 * frame. Messages are `{ id, op, args }`; each gets `{ id, ok, value }` or
 * `{ id, ok: false, error }` back. Pixel buffers are transferred, not copied.
 *
 * If OPFS or IndexedDB can't be opened (e.g. some private-browsing modes),
 * the app keeps working on in-memory storage and says that nothing is saved.
 */

declare const self: DedicatedWorkerGlobalScope;

export interface Request {
  id: number;
  op: StorageOp;
  args: unknown[];
}

export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { name: string; message: string } };

const service: Promise<StorageService> = (async () => {
  try {
    const [files, catalog] = await Promise.all([OpfsBlobStore.open(), IdbCatalog.open()]);
    return new StorageService(files, catalog);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new StorageService(new MemoryBlobStore(), new MemoryCatalog(), { persistent: false, reason });
  }
})();

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, op, args } = event.data;
  try {
    const s = await service;
    const value: unknown = await (s[op] as (...a: unknown[]) => Promise<unknown>).apply(s, args);
    self.postMessage({ id, ok: true, value } satisfies Reply, transferables(value));
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    self.postMessage({ id, ok: false, error: { name: e.name, message: e.message } } satisfies Reply);
  }
};

/** Pixel buffers in a reply, moved rather than copied. */
function transferables(value: unknown): Transferable[] {
  if (value instanceof Uint8Array) return [value.buffer as ArrayBuffer];
  return [];
}
