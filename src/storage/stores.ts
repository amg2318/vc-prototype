import type { HeadRecord, ProjectId, ProjectInfo } from './format';

/**
 * The two kinds of storage a project uses, as small interfaces so the save
 * logic can be unit-tested with in-memory versions (and crash-tested by
 * wrapping them):
 *
 * - `BlobStore`: files by path. In the app this is OPFS, written with sync
 *   access handles in the storage worker (`opfsBlobStore.ts`). Writes are
 *   *not* atomic: a crash can leave a file half written.
 * - `Catalog`: the project list and each project's head record. In the app
 *   this is IndexedDB (`idbCatalog.ts`). `commitHead` is atomic: after a
 *   crash the old head or the new one is there, never a mix. That makes it
 *   the commit point of every save.
 */

export interface BlobEntry {
  name: string;
  kind: 'file' | 'dir';
  /** Bytes (0 for folders). */
  size: number;
}

export interface BlobStore {
  /** The file's bytes, or null if there is no such file. */
  read(path: string): Promise<Uint8Array | null>;
  /** Create or replace a file (creating folders as needed). Throws QuotaExceededError when storage is full. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Delete a file; no error if it doesn't exist. */
  remove(path: string): Promise<void>;
  /** What is directly inside a folder ('' = the root); [] if the folder doesn't exist. */
  list(dir: string): Promise<BlobEntry[]>;
  /** Delete a folder and everything in it. */
  removeDir(dir: string): Promise<void>;
}

export interface Catalog {
  projects(): Promise<ProjectInfo[]>;
  project(id: ProjectId): Promise<ProjectInfo | null>;
  putProject(info: ProjectInfo): Promise<void>;
  head(id: ProjectId): Promise<HeadRecord | null>;
  /**
   * Atomically replace the project's head, and (if given) its info, in one
   * transaction. Durable once the promise resolves.
   */
  commitHead(head: HeadRecord, info?: ProjectInfo): Promise<void>;
  /** Remove the project's info and head. */
  deleteProject(id: ProjectId): Promise<void>;
}

/** A view of `store` inside folder `prefix` (each project gets its own folder). */
export function scopedStore(store: BlobStore, prefix: string): BlobStore {
  const at = (path: string): string => (path ? `${prefix}/${path}` : prefix);
  return {
    read: (path) => store.read(at(path)),
    write: (path, bytes) => store.write(at(path), bytes),
    remove: (path) => store.remove(at(path)),
    list: (dir) => store.list(at(dir)),
    removeDir: (dir) => store.removeDir(at(dir)),
  };
}

export function projectFolder(id: ProjectId): string {
  return `projects/${id}`;
}

/** True for the error browsers throw when storage is full. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.name === 'QuotaExceededError';
}

export function quotaError(): Error {
  const error = new Error('Storage is full');
  error.name = 'QuotaExceededError';
  return error;
}

// --- in-memory versions (tests, and a fallback when OPFS isn't available) ----

export class MemoryBlobStore implements BlobStore {
  readonly files = new Map<string, Uint8Array>();

  /** Optional limit on the total bytes stored, to test running out of space. */
  constructor(public quotaBytes = Infinity) {}

  get bytesUsed(): number {
    let total = 0;
    for (const bytes of this.files.values()) total += bytes.byteLength;
    return total;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes ? bytes.slice() : null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const growth = bytes.byteLength - (this.files.get(path)?.byteLength ?? 0);
    if (this.bytesUsed + growth > this.quotaBytes) throw quotaError();
    this.files.set(path, bytes.slice());
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(dir: string): Promise<BlobEntry[]> {
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map<string, BlobEntry>();
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, { name: rest, kind: 'file', size: bytes.byteLength });
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'dir', size: 0 });
    }
    return [...entries.values()];
  }

  async removeDir(dir: string): Promise<void> {
    for (const path of [...this.files.keys()]) if (path.startsWith(`${dir}/`)) this.files.delete(path);
  }
}

/** Keeps copies (like IndexedDB's structured clone), so callers can't change stored data by accident. */
export class MemoryCatalog implements Catalog {
  readonly infos = new Map<ProjectId, ProjectInfo>();
  readonly heads = new Map<ProjectId, HeadRecord>();

  async projects(): Promise<ProjectInfo[]> {
    return [...this.infos.values()].map((p) => structuredClone(p));
  }

  async project(id: ProjectId): Promise<ProjectInfo | null> {
    const info = this.infos.get(id);
    return info ? structuredClone(info) : null;
  }

  async putProject(info: ProjectInfo): Promise<void> {
    this.infos.set(info.id, structuredClone(info));
  }

  async head(id: ProjectId): Promise<HeadRecord | null> {
    const head = this.heads.get(id);
    return head ? structuredClone(head) : null;
  }

  async commitHead(head: HeadRecord, info?: ProjectInfo): Promise<void> {
    this.heads.set(head.projectId, structuredClone(head));
    if (info) this.infos.set(info.id, structuredClone(info));
  }

  async deleteProject(id: ProjectId): Promise<void> {
    this.infos.delete(id);
    this.heads.delete(id);
  }
}
