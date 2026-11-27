import type { AsyncApi, StorageApi, StorageOp } from './service';
import type { Reply, Request } from './storage.worker';

/**
 * The main thread's handle on the storage worker: the same methods as
 * `StorageService`, each returning a promise. Calls are answered in order.
 *
 * `inProcess` wraps a StorageService directly (tests, and anything that
 * wants the same interface without a worker).
 */
export type StorageClient = AsyncApi & {
  /** Calls sent and not yet answered (the HUD's save queue). */
  readonly pending: number;
};

export function workerClient(worker: Worker): StorageClient {
  let nextId = 1;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data;
    const call = waiting.get(reply.id);
    if (!call) return;
    waiting.delete(reply.id);
    if (reply.ok) call.resolve(reply.value);
    else call.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
  };
  const call = (op: StorageOp, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args } satisfies Request, transfersFor(op, args));
    });
  return clientFrom(call, () => waiting.size);
}

/** Tile pixels sent for saving are moved to the worker, not copied (the caller must not reuse them). */
function transfersFor(op: StorageOp, args: unknown[]): Transferable[] {
  if (op === 'putTiles') return (args[0] as Uint8Array[]).map((t) => t.buffer as ArrayBuffer);
  if (op === 'importProject') return [(args[0] as Uint8Array).buffer as ArrayBuffer];
  return [];
}

export function inProcessClient(service: AsyncApi): StorageClient {
  let pending = 0;
  const call = async (op: StorageOp, args: unknown[]): Promise<unknown> => {
    pending++;
    try {
      return await (service[op] as (...a: unknown[]) => Promise<unknown>).apply(service, args);
    } finally {
      pending--;
    }
  };
  return clientFrom(call, () => pending);
}

const OPS: readonly StorageOp[] = [
  'status',
  'listProjects',
  'createProject',
  'openProject',
  'closeProject',
  'renameProject',
  'deleteProject',
  'duplicateProject',
  'putTiles',
  'getTile',
  'readProject',
  'commit',
  'updateHead',
  'exportProject',
  'importProject',
  'gcBegin',
  'gcMark',
  'gcSweep',
  'gcFinish',
  'gcCancel',
  'readThumbnail',
  'workingPreview',
] satisfies (keyof StorageApi)[];

function clientFrom(call: (op: StorageOp, args: unknown[]) => Promise<unknown>, pending: () => number): StorageClient {
  const client = Object.fromEntries(OPS.map((op) => [op, (...args: unknown[]) => call(op, args)])) as unknown as AsyncApi;
  return Object.defineProperty(client, 'pending', { get: pending }) as StorageClient;
}

export function createStorageWorker(): Worker {
  return new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
}
