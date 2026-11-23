import {
  FORMAT_VERSION,
  manifestPath,
  newId,
  objectPath,
  recordTileHashes,
  thumbnailPath,
  validateManifest,
  validateRecord,
  type CanvasRecord,
  type HeadRecord,
  type ManifestId,
  type ObjectKind,
  type ProjectId,
  type ProjectInfo,
  type RootManifest,
} from './format';
import { migrateManifest, migrateRecord } from './migrations';
import {
  decodeObject,
  encodeJson,
  encodeObject,
  isEmptyTile,
  objectProblem,
  type EncodedObject,
  type ObjectHash,
} from './objectCodec';
import type { BlobStore, Catalog } from './stores';

/** A canvas in a commit: a new or changed record, or the hash of one already saved. */
export type CanvasEntry = { id: string; record: CanvasRecord } | { id: string; hash: ObjectHash };

export interface CommitRequest {
  /** Back to front. */
  canvases: CanvasEntry[];
  canvasCounter: number;
  activeCanvasId: string | null;
  view?: RootManifest['view'];
  /** Further changes to the head in the same atomic step (e.g. add a version pointing at the new manifest). */
  editHead?: (head: HeadRecord, manifestId: ManifestId) => HeadRecord;
  /** A thumbnail written before the head (for a version added by `editHead`). */
  thumbnail?: { name: string; bytes: Uint8Array };
}

export interface CommitResult {
  manifestId: ManifestId;
  /** Record hash of every canvas, by canvas id. */
  recordHashes: Map<string, ObjectHash>;
  /** Bytes written to disk by this commit (records, thumbnail, manifest). */
  bytesWritten: number;
  head: HeadRecord;
}

export interface PutResult {
  hash: ObjectHash;
  /** Bytes written: 0 when an identical object was already stored. */
  written: number;
}

/** A tile or record that should be on disk isn't (or is damaged). */
export class MissingObjectError extends Error {
  constructor(kind: ObjectKind, hash: ObjectHash) {
    super(`The ${kind} ${hash.slice(0, 12)}… is missing or damaged`);
    this.name = 'MissingObjectError';
  }
}

/**
 * One project's saved data: content-addressed objects, manifests and the head.
 * Runs in the storage worker; GPU- and DOM-free, so it is unit-tested with
 * in-memory stores.
 *
 * **The commit sequence** (`commit`), which keeps the head pointing to a
 * complete project whatever moment the app dies at:
 *
 *  1. Tiles are written first, by `putTile`, before the commit is asked for.
 *  2. Changed canvas records are written (content-addressed, like tiles).
 *  3. Every object the new manifest needs is checked to be on disk and valid.
 *  4. The root manifest is written under a new, unique name. Nothing points
 *     to it yet, so a crash here leaves only an unused file.
 *  5. The head is replaced in one atomic catalog transaction: the commit point.
 *  6. Only then, the old working manifest is deleted if nothing refers to it.
 *     Tiles and records nothing refers to are left for garbage collection.
 *
 * Objects are only trusted after checking them (header, length, CRC), so a
 * torn write from an earlier crash is rewritten rather than reused.
 *
 * Operations run one at a time, in the order they were asked for.
 */
export class ProjectStore {
  /** Paths of objects known to be on disk and valid in this session. */
  private readonly verified = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Set while a garbage collection runs: every hash put meanwhile is protected from its sweep. */
  touched: Set<ObjectHash> | null = null;

  private constructor(
    readonly id: ProjectId,
    readonly files: BlobStore,
    private readonly catalog: Catalog,
    private info: ProjectInfo,
    private currentHead: HeadRecord | null,
  ) {}

  /** Open an existing project (its head may be missing if it was never saved). */
  static async open(id: ProjectId, files: BlobStore, catalog: Catalog): Promise<ProjectStore> {
    const info = await catalog.project(id);
    if (!info) throw new Error(`No project ${id}`);
    return new ProjectStore(id, files, catalog, info, await catalog.head(id));
  }

  /** A new project. Nothing is saved until the first commit, which also records the project. */
  static create(info: ProjectInfo, files: BlobStore, catalog: Catalog): ProjectStore {
    return new ProjectStore(info.id, files, catalog, { ...info }, null);
  }

  get head(): HeadRecord | null {
    return this.currentHead;
  }

  get projectInfo(): ProjectInfo {
    return { ...this.info };
  }

  /** Run `task` after every operation asked for before it. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // --- objects ----------------------------------------------------------------

  /**
   * Hash, compress and store a tile's raw premultiplied RGBA. Returns null for
   * a fully transparent tile, which is never stored.
   */
  async putTile(rgba: Uint8Array): Promise<PutResult | null> {
    if (isEmptyTile(rgba)) return null;
    const encoded = await encodeObject(rgba);
    return this.exclusive(async () => ({ hash: encoded.hash, written: await this.putEncoded('tile', encoded) }));
  }

  /** Store an encoded object unless a valid copy is already there. Returns the bytes written. */
  private async putEncoded(kind: ObjectKind, encoded: EncodedObject): Promise<number> {
    this.touched?.add(encoded.hash);
    if (await this.isStored(kind, encoded.hash)) return 0; // deduplicated
    const path = objectPath(kind, encoded.hash);
    const previous = await this.files.read(path); // a damaged leftover, if any
    await this.files.write(path, encoded.bytes);
    this.verified.add(path);
    const written = encoded.bytes.byteLength;
    this.info.sizeBytes += written - (previous?.byteLength ?? 0);
    return written;
  }

  /** True if a valid copy of the object is on disk (checked once per session). */
  async isStored(kind: ObjectKind, hash: ObjectHash): Promise<boolean> {
    const path = objectPath(kind, hash);
    if (this.verified.has(path)) return true;
    const bytes = await this.files.read(path);
    if (!bytes || objectProblem(bytes)) return false;
    this.verified.add(path);
    return true;
  }

  /** A tile's raw RGBA. Throws MissingObjectError if it isn't stored or is damaged. */
  async getTile(hash: ObjectHash): Promise<Uint8Array> {
    const bytes = await this.files.read(objectPath('tile', hash));
    if (!bytes) throw new MissingObjectError('tile', hash);
    try {
      return await decodeObject(bytes);
    } catch {
      throw new MissingObjectError('tile', hash);
    }
  }

  /** The stored bytes of an object exactly as on disk (for export), or null. */
  readStoredObject(kind: ObjectKind, hash: ObjectHash): Promise<Uint8Array | null> {
    return this.files.read(objectPath(kind, hash));
  }

  /** Forget that an object was verified (garbage collection deleted it). */
  forgetVerified(path: string): void {
    this.verified.delete(path);
  }

  /** Change the bytes counted for the project (garbage collection deleted files). */
  adjustSize(deltaBytes: number): void {
    this.info.sizeBytes = Math.max(0, this.info.sizeBytes + deltaBytes);
  }

  // --- manifests and records ----------------------------------------------------

  async readRecord(hash: ObjectHash): Promise<CanvasRecord> {
    const bytes = await this.files.read(objectPath('record', hash));
    if (!bytes) throw new MissingObjectError('record', hash);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(await decodeObject(bytes)));
    } catch {
      throw new MissingObjectError('record', hash);
    }
    return validateRecord(migrateRecord(json));
  }

  async readManifest(id: ManifestId): Promise<RootManifest> {
    const bytes = await this.files.read(manifestPath(id));
    if (!bytes) throw new Error(`Manifest ${id} is missing`);
    return validateManifest(migrateManifest(JSON.parse(new TextDecoder().decode(bytes))));
  }

  /** The working copy: its manifest and every canvas record, in z-order. */
  async readWorkingCopy(): Promise<{ manifest: RootManifest; records: CanvasRecord[] } | null> {
    const head = this.currentHead;
    return head ? this.readProject(head.working) : null;
  }

  async readProject(manifestId: ManifestId): Promise<{ manifest: RootManifest; records: CanvasRecord[] }> {
    const manifest = await this.readManifest(manifestId);
    const records = await Promise.all(manifest.canvases.map((c) => this.readRecord(c.record)));
    return { manifest, records };
  }

  // --- the commit sequence ----------------------------------------------------

  /** Save a new working copy (steps 2–6 above). See the class comment. */
  commit(request: CommitRequest): Promise<CommitResult> {
    return this.exclusive(async () => {
      let bytesWritten = 0;
      const recordHashes = new Map<string, ObjectHash>();
      const tileHashes = new Set<ObjectHash>();

      // 2. Changed canvas records.
      for (const entry of request.canvases) {
        if ('hash' in entry) {
          recordHashes.set(entry.id, entry.hash);
          continue;
        }
        const encoded = await encodeJson(entry.record);
        bytesWritten += await this.putEncoded('record', encoded);
        recordHashes.set(entry.id, encoded.hash);
        recordTileHashes(entry.record, tileHashes);
      }

      // 3. Everything the manifest refers to must be on disk. (Records reused by
      // hash were checked when they were first saved or read.)
      for (const hash of recordHashes.values()) {
        if (!(await this.isStored('record', hash))) throw new MissingObjectError('record', hash);
      }
      for (const hash of tileHashes) {
        if (!(await this.isStored('tile', hash))) throw new MissingObjectError('tile', hash);
      }

      if (request.thumbnail) {
        await this.files.write(thumbnailPath(request.thumbnail.name), request.thumbnail.bytes);
        bytesWritten += request.thumbnail.bytes.byteLength;
        this.info.sizeBytes += request.thumbnail.bytes.byteLength;
      }

      // 4. The manifest, under a new name.
      const manifest: RootManifest = {
        formatVersion: FORMAT_VERSION,
        id: newId('m'),
        createdAt: Date.now(),
        canvases: request.canvases.map((c) => ({ id: c.id, record: recordHashes.get(c.id)! })),
        canvasCounter: request.canvasCounter,
        activeCanvasId: request.activeCanvasId,
        ...(request.view ? { view: request.view } : {}),
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      await this.files.write(manifestPath(manifest.id), manifestBytes);
      bytesWritten += manifestBytes.byteLength;
      this.info.sizeBytes += manifestBytes.byteLength;

      // 5 and 6.
      const base: HeadRecord = this.currentHead ?? {
        projectId: this.id,
        working: manifest.id,
        versions: [],
        activeMsSinceVersion: 0,
        updatedAt: 0,
      };
      let head: HeadRecord = { ...base, working: manifest.id, updatedAt: Date.now() };
      if (request.editHead) head = request.editHead(head, manifest.id);
      await this.replaceHead(head);
      return { manifestId: manifest.id, recordHashes, bytesWritten, head: this.currentHead! };
    });
  }

  /**
   * Change the head without a new manifest (rename, pin or delete a version;
   * restore points the working copy at a version's manifest).
   */
  updateHead(edit: (head: HeadRecord) => HeadRecord, thumbnail?: { name: string; bytes: Uint8Array }): Promise<HeadRecord> {
    return this.exclusive(async () => {
      if (!this.currentHead) throw new Error('The project has not been saved yet');
      if (thumbnail) {
        await this.files.write(thumbnailPath(thumbnail.name), thumbnail.bytes);
        this.info.sizeBytes += thumbnail.bytes.byteLength;
      }
      await this.replaceHead(edit(structuredClone(this.currentHead)));
      return this.currentHead!;
    });
  }

  /**
   * Step 5 (atomic head replacement) and step 6 (clean-up of what only the old
   * head used). The size recorded with the head already leaves out the files
   * about to be removed; if the app dies before they are, garbage collection
   * removes them and recounts.
   */
  private async replaceHead(head: HeadRecord): Promise<void> {
    const unused = this.currentHead ? unusedFiles(this.currentHead, head) : [];
    let freed = 0;
    for (const path of unused) freed += (await this.files.read(path))?.byteLength ?? 0;
    this.adjustSize(-freed);
    await this.catalog.commitHead(head, this.info);
    this.currentHead = head;
    for (const path of unused) await this.files.remove(path);
  }

  /** Rename the project (in the catalog only). */
  async rename(name: string): Promise<void> {
    await this.exclusive(async () => {
      this.info = { ...this.info, name };
      await this.catalog.putProject(this.info);
    });
  }
}

/** Manifests and thumbnails the old head used and the new one doesn't. */
function unusedFiles(before: HeadRecord, after: HeadRecord): string[] {
  const keep = new Set([after.working, ...after.versions.map((v) => v.manifestId)]);
  const keepThumbnails = new Set(after.versions.flatMap((v) => (v.thumbnail ? [v.thumbnail] : [])));
  const manifests = new Set([before.working, ...before.versions.map((v) => v.manifestId)]);
  const thumbnails = new Set(before.versions.flatMap((v) => (v.thumbnail ? [v.thumbnail] : [])));
  return [
    ...[...manifests].filter((id) => !keep.has(id)).map(manifestPath),
    ...[...thumbnails].filter((name) => !keepThumbnails.has(name)).map(thumbnailPath),
  ];
}
