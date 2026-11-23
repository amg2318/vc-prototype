import type { CanvasRecord, HeadRecord, ManifestId, ProjectId, ProjectInfo, RootManifest, VersionEntry } from './format';
import { newId } from './format';
import { ProjectStore, type CanvasEntry, type PutResult } from './projectStore';
import { projectFolder as folderOf, scopedStore, type BlobStore, type Catalog } from './stores';

/**
 * Everything the app asks of storage, as one object whose methods take and
 * return plain data, so they can be called across the worker boundary
 * (`storage.worker.ts`, `client.ts`) or directly in tests.
 *
 * One project is open at a time; the tile and save operations apply to it.
 */

/** Head changes the app asks for. A version with `manifestId: null` points at the manifest this commit writes. */
export interface HeadEdit {
  working?: ManifestId;
  versions?: (Omit<VersionEntry, 'manifestId'> & { manifestId: ManifestId | null })[];
  activeMsSinceVersion?: number;
}

export interface CommitMessage {
  canvases: CanvasEntry[];
  canvasCounter: number;
  activeCanvasId: string | null;
  view?: RootManifest['view'];
  head?: HeadEdit;
  thumbnail?: { name: string; bytes: Uint8Array };
}

export interface CommitReply {
  manifestId: ManifestId;
  recordHashes: [string, string][];
  bytesWritten: number;
  head: HeadRecord;
  info: ProjectInfo;
}

export interface OpenedProject {
  info: ProjectInfo;
  head: HeadRecord | null;
}

export interface StorageStatus {
  /** False if OPFS or IndexedDB couldn't be opened: nothing survives a reload. */
  persistent: boolean;
  reason: string | null;
}

/** The operations, as they are called (each returns a promise of the value). */
export interface StorageApi {
  status(): StorageStatus;
  listProjects(): ProjectInfo[];
  createProject(name: string): ProjectInfo;
  openProject(id: ProjectId): OpenedProject;
  closeProject(): void;
  renameProject(id: ProjectId, name: string): ProjectInfo;
  deleteProject(id: ProjectId): void;
  duplicateProject(id: ProjectId, name: string): ProjectInfo;
  putTiles(tiles: Uint8Array[]): (PutResult | null)[];
  getTile(hash: string): Uint8Array;
  readProject(manifestId: ManifestId | null): { manifest: RootManifest; records: CanvasRecord[] } | null;
  commit(message: CommitMessage): CommitReply;
  updateHead(edit: HeadEdit): HeadRecord;
  readThumbnail(name: string): Uint8Array | null;
}

export type StorageOp = keyof StorageApi;
export type AsyncApi = { [K in StorageOp]: (...args: Parameters<StorageApi[K]>) => Promise<ReturnType<StorageApi[K]>> };

export class StorageService implements AsyncApi {
  private current: ProjectStore | null = null;

  constructor(
    private readonly root: BlobStore,
    private readonly catalog: Catalog,
    private readonly storageStatus: StorageStatus = { persistent: true, reason: null },
  ) {}

  private get project(): ProjectStore {
    if (!this.current) throw new Error('No project is open');
    return this.current;
  }

  private files(id: ProjectId): BlobStore {
    return scopedStore(this.root, folderOf(id));
  }

  async status(): Promise<StorageStatus> {
    return this.storageStatus;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const projects = await this.catalog.projects();
    // The open project's size is kept in memory between saves.
    return projects.map((p) => (p.id === this.current?.id ? this.current.projectInfo : p));
  }

  async createProject(name: string): Promise<ProjectInfo> {
    const now = Date.now();
    const info: ProjectInfo = { id: newId('p'), name, createdAt: now, lastOpenedAt: now, sizeBytes: 0 };
    await this.catalog.putProject(info);
    return info;
  }

  async openProject(id: ProjectId): Promise<OpenedProject> {
    const info = await this.catalog.project(id);
    if (!info) throw new Error(`No project ${id}`);
    await this.catalog.putProject({ ...info, lastOpenedAt: Date.now() });
    this.current = await ProjectStore.open(id, this.files(id), this.catalog);
    return { info: this.current.projectInfo, head: this.current.head };
  }

  async closeProject(): Promise<void> {
    this.current = null;
  }

  async renameProject(id: ProjectId, name: string): Promise<ProjectInfo> {
    if (this.current?.id === id) {
      await this.current.rename(name);
      return this.current.projectInfo;
    }
    const info = await this.catalog.project(id);
    if (!info) throw new Error(`No project ${id}`);
    const renamed = { ...info, name };
    await this.catalog.putProject(renamed);
    return renamed;
  }

  /** Remove the project from the list first, then its folder: a crash in between leaves only unlisted files. */
  async deleteProject(id: ProjectId): Promise<void> {
    if (this.current?.id === id) this.current = null;
    await this.catalog.deleteProject(id);
    await this.root.removeDir(folderOf(id));
  }

  /**
   * Copy every file of a project into a new one. The copy is listed (with
   * its head) only after all its files are written.
   */
  async duplicateProject(id: ProjectId, name: string): Promise<ProjectInfo> {
    const head = await this.catalog.head(id);
    const now = Date.now();
    const copy: ProjectInfo = { id: newId('p'), name, createdAt: now, lastOpenedAt: now, sizeBytes: 0 };
    copy.sizeBytes = await copyTree(this.files(id), this.files(copy.id), '');
    if (head) await this.catalog.commitHead({ ...head, projectId: copy.id, updatedAt: now }, copy);
    else await this.catalog.putProject(copy);
    return copy;
  }

  async putTiles(tiles: Uint8Array[]): Promise<(PutResult | null)[]> {
    const project = this.project;
    return Promise.all(tiles.map((t) => project.putTile(t)));
  }

  getTile(hash: string): Promise<Uint8Array> {
    return this.project.getTile(hash);
  }

  async readProject(manifestId: ManifestId | null): Promise<{ manifest: RootManifest; records: CanvasRecord[] } | null> {
    const project = this.project;
    if (manifestId === null) return project.readWorkingCopy();
    return project.readProject(manifestId);
  }

  async commit(message: CommitMessage): Promise<CommitReply> {
    const { head: edit, ...rest } = message;
    const result = await this.project.commit({
      ...rest,
      ...(edit ? { editHead: (head, manifestId) => applyEdit(head, edit, manifestId) } : {}),
    });
    return {
      manifestId: result.manifestId,
      recordHashes: [...result.recordHashes],
      bytesWritten: result.bytesWritten,
      head: result.head,
      info: this.project.projectInfo,
    };
  }

  updateHead(edit: HeadEdit): Promise<HeadRecord> {
    return this.project.updateHead((head) => applyEdit(head, edit, null));
  }

  readThumbnail(name: string): Promise<Uint8Array | null> {
    return this.project.files.read(`thumbnails/${name}`);
  }
}

function applyEdit(head: HeadRecord, edit: HeadEdit, newManifest: ManifestId | null): HeadRecord {
  const next = { ...head };
  if (edit.working !== undefined) next.working = edit.working;
  if (edit.activeMsSinceVersion !== undefined) next.activeMsSinceVersion = edit.activeMsSinceVersion;
  if (edit.versions) {
    next.versions = edit.versions.map((v) => {
      const manifestId = v.manifestId ?? newManifest;
      if (!manifestId) throw new Error(`Version ${v.id} has no manifest`);
      return { ...v, manifestId };
    });
  }
  return next;
}

/** Copy a folder tree; returns the bytes copied. */
async function copyTree(from: BlobStore, to: BlobStore, dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await from.list(dir)) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.kind === 'dir') {
      bytes += await copyTree(from, to, path);
    } else {
      const data = await from.read(path);
      if (data) {
        await to.write(path, data);
        bytes += data.byteLength;
      }
    }
  }
  return bytes;
}
