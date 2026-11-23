import type { BlobEntry, BlobStore } from './stores';

/**
 * BlobStore on the Origin Private File System, for the storage worker.
 *
 * Files are written with a sync access handle where the browser has one
 * (Safari and Chromium in dedicated workers): truncate, write, flush, close.
 * `flush()` makes the bytes durable before the commit moves on to the next
 * step. Otherwise it falls back to `createWritable()`.
 *
 * A write is not atomic: a crash can leave a file empty or half written.
 * The objects written here carry a length and a CRC, and manifests are only
 * referenced once complete, so the save logic never trusts a torn file.
 */
/** The worker-only part of the OPFS API (not in TypeScript's DOM types). */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}
type SyncCapableFileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncAccessHandle> };

export class OpfsBlobStore implements BlobStore {
  private readonly dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsBlobStore> {
    return new OpfsBlobStore(await navigator.storage.getDirectory());
  }

  async read(path: string): Promise<Uint8Array | null> {
    const file = await this.fileHandle(path, false);
    if (!file) return null;
    return new Uint8Array(await (await file.getFile()).arrayBuffer());
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const file = (await this.fileHandle(path, true))! as SyncCapableFileHandle;
    if (typeof file.createSyncAccessHandle === 'function') {
      const handle = await file.createSyncAccessHandle();
      try {
        handle.truncate(0);
        let written = 0;
        while (written < bytes.byteLength) written += handle.write(bytes.subarray(written), { at: written });
        handle.flush();
      } finally {
        handle.close();
      }
    } else {
      const writable = await file.createWritable();
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    }
  }

  async remove(path: string): Promise<void> {
    const { dir, name } = split(path);
    const parent = await this.dirHandle(dir, false);
    if (!parent) return;
    await parent.removeEntry(name).catch(ignoreNotFound);
  }

  async list(dir: string): Promise<BlobEntry[]> {
    const handle = await this.dirHandle(dir, false);
    if (!handle) return [];
    const entries: BlobEntry[] = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'directory') entries.push({ name, kind: 'dir', size: 0 });
      else entries.push({ name, kind: 'file', size: (await (entry as FileSystemFileHandle).getFile()).size });
    }
    return entries;
  }

  async removeDir(dir: string): Promise<void> {
    const { dir: parentPath, name } = split(dir);
    const parent = await this.dirHandle(parentPath, false);
    for (const key of [...this.dirs.keys()]) if (key === dir || key.startsWith(`${dir}/`)) this.dirs.delete(key);
    if (parent) await parent.removeEntry(name, { recursive: true }).catch(ignoreNotFound);
  }

  private async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const { dir, name } = split(path);
    const parent = await this.dirHandle(dir, create);
    if (!parent) return null;
    try {
      return await parent.getFileHandle(name, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }

  /** The folder at `path` (cached), or null if it doesn't exist and `create` is false. */
  private async dirHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    if (!path) return this.root;
    const cached = this.dirs.get(path);
    if (cached) return cached;
    const { dir, name } = split(path);
    const parent = await this.dirHandle(dir, create);
    if (!parent) return null;
    try {
      const handle = parent.getDirectoryHandle(name, { create });
      this.dirs.set(path, handle);
      return await handle;
    } catch (error) {
      this.dirs.delete(path);
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }
}

function split(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

function ignoreNotFound(error: unknown): void {
  if (!isNotFound(error)) throw error;
}
