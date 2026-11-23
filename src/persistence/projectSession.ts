import { GC, SAVE, TILE_BYTES, VERSIONS } from '../config';
import { tileCoords } from '../document/tiles';
import { PyramidPlanner } from '../render/pyramid';
import type { PreviewTile } from '../render/renderer';
import { tileMapKey, type CanvasRecord } from '../storage/format';
import type { PaintDocument } from '../document/paintDocument';
import type { TileId } from '../document/tiles';
import type { Renderer } from '../render/renderer';
import type { StorageClient } from '../storage/client';
import type { ProjectId, ProjectInfo, RootManifest } from '../storage/format';
import type { ObjectHash } from '../storage/objectCodec';
import { isQuotaError } from '../storage/stores';
import type { Workspace } from '../workspace/workspace';
import { AutosaveScheduler } from './autosaveScheduler';
import { DiskTileBackingStore } from './diskTileBackingStore';
import { ProjectSaver, type SaveOptions, type SaveStats } from './saver';
import { canvasFromRecord } from './snapshot';
import { TileHashes } from './tileHashes';
import { isProjectLocked, tryLockProject, type HeldLock } from './projectLock';
import { applyRetention, type RetentionRules } from './retention';
import { ActiveTime, addVersionEdit, newVersion, workingCopyUnversioned } from './versions';
import { renderWorkspaceThumbnail } from './workspaceThumbnail';
import { DEFAULT_RETENTION } from './storageSettings';
import type { HeadRecord, VersionEntry } from '../storage/format';
import type { HeadEdit } from '../storage/service';

/**
 * The open project: loading it into the workspace, and keeping it saved.
 *
 * Owns the pieces of the saving model on the main thread: the tile hashes,
 * the disk backing store for evicted tiles, the saver and the autosave
 * scheduler. The app reports changes and strokes; the session decides when
 * to save, and reports its status for the save indicator.
 */

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'read-only' | 'not-persistent';

export interface SaveStatus {
  state: SaveState;
  /** When the working copy was last saved (ms since the epoch). */
  savedAt: number | null;
  message: string | null;
  /** True for a "storage full" error. */
  quota: boolean;
}

export interface GcStats {
  ms: number;
  removedFiles: number;
  removedBytes: number;
  /** The project's size afterwards (bytes). */
  sizeBytes: number;
}

export interface SessionDeps {
  workspace: Workspace;
  renderer: Renderer;
  storage: StorageClient;
  /** The camera to save with the working copy. */
  view(): RootManifest['view'];
  /** Canvases for a new, empty project. */
  newProjectCanvases(workspace: Workspace): PaintDocument[];
}

const LAST_PROJECT_KEY = 'vc-last-project';

export const QUOTA_MESSAGE = 'Storage is full: your latest changes are not saved. Delete old automatic versions or export and delete projects to make room.';

export class ProjectSession {
  readonly hashes: TileHashes;
  readonly backing: DiskTileBackingStore;
  readonly saver: ProjectSaver;
  readonly scheduler: AutosaveScheduler;
  project: ProjectInfo | null = null;
  status: SaveStatus = { state: 'saved', savedAt: null, message: null, quota: false };
  /** Called whenever `status` changes. */
  onStatus: ((status: SaveStatus) => void) | null = null;
  /** Called after each save with its measurements (for the HUD). */
  onSaved: ((stats: SaveStats) => void) | null = null;
  /** Called after each garbage collection (for the HUD). */
  onGarbageCollected: ((stats: GcStats) => void) | null = null;
  lastGc: GcStats | null = null;
  private gcRunning = false;
  private gcTimer = 0;
  /** Called when the version list changes. */
  onVersions: ((versions: readonly VersionEntry[]) => void) | null = null;
  /** Retention rules for automatic versions (the settings panel may change them). */
  retention: RetentionRules = { ...DEFAULT_RETENTION };
  private persistent = true;
  /** This tab's lock on the open project; null when another tab has it (read-only). */
  private lock: HeldLock | null = null;
  private activeTime = new ActiveTime(0, VERSIONS.activeInputWindowMs);
  /** Version operations in progress (one at a time, so each edits the latest version list). */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SessionDeps) {
    const { workspace, renderer, storage } = deps;
    this.hashes = new TileHashes(workspace.store);
    this.backing = new DiskTileBackingStore(storage, this.hashes, workspace.store);
    renderer.useBackingStore(this.backing);
    this.backing.onWriteError = (error) => {
      // The tile is kept in memory instead, so nothing is lost yet; but saving will fail the same way.
      if (isQuotaError(error)) this.setStatus({ state: 'error', message: QUOTA_MESSAGE, quota: true });
    };
    renderer.onCompositeChanged = (canvasId) => this.saver.previewsDirty.add(canvasId);
    this.saver = new ProjectSaver({
      workspace,
      hashes: this.hashes,
      storage,
      readLayerTiles: (ids) => renderer.readLayerTiles(ids),
      readPreviewTiles: (canvasId) => renderer.readPreviewTiles(canvasId),
      view: () => deps.view(),
      headExtras: () => ({ activeMsSinceVersion: Math.round(this.activeTime.ms) }),
    });
    this.scheduler = new AutosaveScheduler(async () => {
      // While the page is hidden, every second counts (it may be closed for good): skip the previews.
      await this.saveWorkingCopy({ skipPreviews: document.visibilityState === 'hidden' });
    }, SAVE.debounceMs);
    workspace.onChange(() => {
      if (this.scheduler.paused) return;
      this.scheduler.changed();
      this.noteActivity();
      if (this.status.state === 'saved') this.setStatus({ state: 'unsaved' });
    });
  }

  /**
   * Save at once when the page is hidden or closed (`beforeunload` and
   * `unload` often don't fire on iPad). A moved camera is saved then too.
   */
  watchPageLifecycle(): void {
    const flush = (): void => {
      if (this.saver.viewChanged() && !this.scheduler.paused) this.scheduler.changed();
      this.scheduler.flush();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      else if (this.saver.previewsDirty.size > 0) this.scheduler.changed(); // previews skipped while hidden
    });
    window.addEventListener('pagehide', flush);
  }

  // --- opening ----------------------------------------------------------------

  /** Open the last opened project, or the most recent one, or a new one. Returns the saved camera, if any. */
  async openLast(): Promise<RootManifest['view'] | undefined> {
    const status = await this.deps.storage.status();
    this.persistent = status.persistent;
    const projects = await this.deps.storage.listProjects();
    const last = localStorage.getItem(LAST_PROJECT_KEY);
    const choice = projects.find((p) => p.id === last) ?? [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    if (choice) return this.open(choice.id);
    await this.create('Untitled project');
    return undefined;
  }

  /**
   * Save the current project, then load `id` (with a fresh undo history).
   * If another tab has it open, it opens read-only here.
   */
  async open(id: ProjectId): Promise<RootManifest['view'] | undefined> {
    await this.scheduler.settle();
    this.scheduler.paused = true; // loading is not a change to save
    clearTimeout(this.gcTimer);
    if (this.lock?.projectId !== id) {
      // Reopening the same project keeps its lock; otherwise let go of the old one first.
      await this.lock?.release();
      this.lock = await tryLockProject(id);
    }
    this.backing.writeToDisk = this.lock !== null;
    const { storage, workspace } = this.deps;
    const opened = await storage.openProject(id);
    this.project = opened.info;
    localStorage.setItem(LAST_PROJECT_KEY, id);
    const copy = await storage.readProject(null);
    if (!copy && this.readOnly) {
      workspace.load(this.deps.newProjectCanvases(workspace), workspace.canvasCounter, null);
      this.saver.remember([], [], null, opened.head);
      this.afterOpen();
      return undefined;
    }
    if (!copy) {
      // Created but never saved: start it with the default canvases.
      workspace.load(this.deps.newProjectCanvases(workspace), workspace.canvasCounter, null);
      this.saver.remember([], [], null, opened.head);
      this.afterOpen();
      await this.saveNow();
      return undefined;
    }
    const previews = await this.load(copy);
    const recordHashes: ObjectHash[] = copy.manifest.canvases.map((c) => c.record);
    this.saver.remember(copy.records, recordHashes, copy.manifest, opened.head);
    this.activeTime = new ActiveTime(opened.head?.activeMsSinceVersion ?? 0, VERSIONS.activeInputWindowMs);
    if (!this.readOnly && workingCopyUnversioned(opened.head)) {
      // The previous session ended with changes no version holds: keep them as a version.
      const level4 = previews.map((p) => p?.find((t) => t.level === 4)?.rgba ?? null);
      await this.addVersionOfWorkingCopy('auto', 'session-ended', opened.head!.updatedAt, copy.records, level4).catch((error: unknown) =>
        console.error('Could not make the "session ended" version:', error),
      );
    }
    this.afterOpen(opened.head?.updatedAt ?? null);
    this.onVersions?.(this.versions);
    if (!this.readOnly) this.scheduleGarbageCollection(GC.delayAfterOpenMs);
    return copy.manifest.view;
  }

  /** Put a saved project state into the workspace (clearing undo history). Returns each canvas's previews. */
  private async load(copy: { manifest: RootManifest; records: CanvasRecord[] }): Promise<(PreviewTile[] | null)[]> {
    const { workspace, renderer } = this.deps;
    const fresh: TileId[] = [];
    const docs: PaintDocument[] = [];
    for (const record of copy.records) {
      const doc = canvasFromRecord(record, workspace.store, this.hashes, (tileId) => fresh.push(tileId));
      if (!doc) throw new Error('This project has more tiles than fit in memory');
      docs.push(doc);
    }
    const previews = await Promise.all(copy.records.map((r) => this.loadPreviews(r)));
    renderer.adoptStoredTiles(fresh);
    workspace.load(docs, copy.manifest.canvasCounter, copy.manifest.activeCanvasId);
    copy.records.forEach((r, i) => {
      if (previews[i]) renderer.seedPreviews(r.id, previews[i]!);
    });
    return previews;
  }

  /**
   * A canvas's saved preview tiles, ready to seed into the renderer: every
   * pinned tile of its size (transparent where none was stored). Null if
   * the record has none (it was saved before its previews were ready).
   */
  private async loadPreviews(record: CanvasRecord): Promise<PreviewTile[] | null> {
    const keys = PyramidPlanner.pinnedKeys(record);
    const saved = new Map(record.previews.map((p) => [p.level, p.tiles]));
    if (keys.some((k) => !saved.has(k.level))) return null;
    return Promise.all(
      keys.map(async ({ level, key }) => {
        const { tx, ty } = tileCoords(key);
        const hash = saved.get(level)![tileMapKey(tx, ty)];
        return { level, key, rgba: hash ? await this.deps.storage.getTile(hash) : new Uint8Array(TILE_BYTES) };
      }),
    );
  }

  // --- versions ---------------------------------------------------------------

  get versions(): readonly VersionEntry[] {
    return this.saver.head?.versions ?? [];
  }

  /** User input (a stroke, an edit): counts as active time; may make an automatic version. */
  noteActivity(now = Date.now()): void {
    if (this.readOnly) return;
    this.activeTime.input(now);
    if (this.activeTime.ms < VERSIONS.autoAfterActiveMin * 60 * 1000) return;
    this.activeTime.reset(); // also stops a second trigger while this one runs
    void this.saveVersion('auto', 'active-time').catch((error: unknown) => console.error('Automatic version failed:', error));
  }

  /**
   * Make a version of the project as it is now: save the working copy (with
   * up-to-date previews), then point a new version at its manifest. Nothing
   * is copied. An automatic version of an unchanged project is skipped.
   */
  async saveVersion(kind: VersionEntry['kind'], reason?: VersionEntry['reason']): Promise<VersionEntry | null> {
    await this.saveNow();
    return this.exclusive(async () => {
      const head = this.saver.head;
      if (!head) return null;
      if (kind === 'auto' && !workingCopyUnversioned(head)) return null;
      const records = this.saver.savedRecords();
      const level4 = await Promise.all(records.map((r) => this.level4Preview(r)));
      return this.addVersionOfWorkingCopy(kind, reason, Date.now(), records, level4);
    });
  }

  /**
   * Make `version` the working copy. The current state is saved first and,
   * unless a version already holds it, kept as a "Before restore" version.
   * Undo history is cleared (it described the state being replaced). The
   * camera stays where it is. Returns the "Before restore" version, if one
   * was made.
   */
  async restoreVersion(version: VersionEntry): Promise<VersionEntry | null> {
    await this.saveNow();
    return this.exclusive(async () => {
      let before: VersionEntry | null = null;
      if (workingCopyUnversioned(this.saver.head)) {
        const records = this.saver.savedRecords();
        const level4 = await Promise.all(records.map((r) => this.level4Preview(r)));
        before = await this.addVersionOfWorkingCopy('auto', 'before-restore', Date.now(), records, level4);
      }
      const copy = await this.deps.storage.readProject(version.manifestId);
      if (!copy) throw new Error(`Version “${version.name}” has no saved state`);
      this.scheduler.paused = true; // loading is not a change to save
      try {
        await this.load(copy);
        this.saver.remember(copy.records, copy.manifest.canvases.map((c) => c.record), copy.manifest, this.saver.head);
      } finally {
        this.scheduler.paused = false;
      }
      // The restored state becomes the working copy (its records and tiles are reused, not copied).
      await this.saveWorkingCopy({ force: true });
      return before;
    });
  }

  async renameVersion(id: string, name: string): Promise<void> {
    await this.editVersions((versions) => versions.map((v) => (v.id === id ? { ...v, name } : v)));
  }

  async pinVersion(id: string, pinned: boolean): Promise<void> {
    await this.editVersions((versions) => versions.map((v) => (v.id === id ? { ...v, pinned } : v)));
  }

  /** Delete a version (its manifest and thumbnail go; tiles it alone used are left for garbage collection). */
  async deleteVersion(id: string): Promise<void> {
    await this.editVersions((versions) => versions.filter((v) => v.id !== id));
    this.scheduleGarbageCollection(GC.delayAfterDeleteMs);
  }

  /**
   * Free space: delete every automatic version that isn't pinned, then
   * collect garbage at once. Returns how many versions were deleted.
   */
  async deleteAutomaticVersions(): Promise<number> {
    const before = this.versions.length;
    await this.editVersions((versions) => versions.filter((v) => v.kind === 'manual' || v.pinned));
    const deleted = before - this.versions.length;
    clearTimeout(this.gcTimer);
    await this.collectGarbage();
    return deleted;
  }

  /** Apply new retention rules now (they also apply each time a version is made). */
  async setRetention(rules: RetentionRules): Promise<void> {
    this.retention = rules;
    if (this.readOnly || !this.saver.head) return;
    await this.editVersions((versions) => applyRetention(versions, Date.now(), rules));
    this.scheduleGarbageCollection(GC.delayAfterDeleteMs);
  }

  // --- garbage collection -------------------------------------------------------

  /** Collect garbage after `delayMs` (a later call replaces an earlier one). */
  scheduleGarbageCollection(delayMs: number): void {
    clearTimeout(this.gcTimer);
    this.gcTimer = window.setTimeout(() => void this.collectGarbage(), delayMs);
  }

  /**
   * Remove the open project's unused tiles, records, manifests and
   * thumbnails (see storage/gc.ts). Runs in the worker in short steps, so
   * drawing and saving carry on. Opening another project stops it (safely).
   * Returns null if it didn't run or was stopped.
   */
  async collectGarbage(): Promise<GcStats | null> {
    if (this.gcRunning || !this.persistent || this.readOnly) return null;
    const { storage } = this.deps;
    const projectId = this.project?.id;
    this.gcRunning = true;
    const start = performance.now();
    try {
      await storage.gcBegin();
      // Collected after `gcBegin` answered: every tile written before it has its hash noted by now.
      await storage.gcMark([...this.hashes.liveHashes(), ...this.saver.previewHashes()]);
      let progress;
      do {
        progress = await storage.gcSweep(GC.sliceMs);
        if (this.project?.id !== projectId) return null;
      } while (!progress.done);
      const sizeBytes = await storage.gcFinish();
      if (this.project) this.project = { ...this.project, sizeBytes };
      const stats = { ms: performance.now() - start, removedFiles: progress.removedFiles, removedBytes: progress.removedBytes, sizeBytes };
      this.lastGc = stats;
      this.onGarbageCollected?.(stats);
      return stats;
    } catch (error) {
      // Stopped (another project was opened) or failed: nothing in use was deleted.
      if (this.project?.id === projectId) console.warn('Garbage collection stopped:', error);
      await storage.gcCancel().catch(() => undefined);
      return null;
    } finally {
      this.gcRunning = false;
    }
  }

  /** A version's thumbnail as PNG bytes, if it has one. */
  async versionThumbnail(version: VersionEntry): Promise<Uint8Array | null> {
    return version.thumbnail ? this.deps.storage.readThumbnail(version.thumbnail) : null;
  }

  /**
   * Point a new version at the working manifest. `records` (for the
   * thumbnail) are what it held when the caller looked; an autosave may have
   * replaced it since, which only makes the version slightly newer.
   */
  private async addVersionOfWorkingCopy(
    kind: VersionEntry['kind'],
    reason: VersionEntry['reason'] | undefined,
    at: number,
    records: readonly CanvasRecord[],
    level4: readonly (Uint8Array | null)[],
  ): Promise<VersionEntry | null> {
    const head = this.saver.head;
    if (!head) return null;
    const version = newVersion(kind, reason, at, null, null); // null: the working manifest when the worker applies it
    const png = await renderWorkspaceThumbnail(
      records.map((r, i) => ({ placement: r, paper: r.paper, paperVisible: r.paperVisible, preview: level4[i] ?? null })),
      VERSIONS.thumbnailPx,
    ).catch(() => null);
    if (png) version.thumbnail = `${version.id}.png`;
    const edit = addVersionEdit(head, version, Date.now(), this.retention);
    await this.applyHeadEdit(edit, png ? { name: version.thumbnail!, bytes: png } : undefined);
    this.activeTime.reset();
    return this.versions.find((v) => v.id === version.id) ?? null;
  }

  private async editVersions(change: (versions: VersionEntry[]) => VersionEntry[]): Promise<void> {
    if (this.readOnly) throw new Error('This project is read-only in this tab');
    await this.exclusive(async () => {
      const head = this.saver.head;
      if (head) await this.applyHeadEdit({ versions: change([...head.versions]) });
    });
  }

  private async applyHeadEdit(edit: HeadEdit, thumbnail?: { name: string; bytes: Uint8Array }): Promise<HeadRecord> {
    const head = await this.deps.storage.updateHead(edit, thumbnail);
    this.saver.head = head;
    this.onVersions?.(head.versions);
    return head;
  }

  /** The canvas's saved level-4 preview tile (null: none saved, or fully transparent). */
  private async level4Preview(record: CanvasRecord): Promise<Uint8Array | null> {
    const hash = record.previews.find((p) => p.level === 4)?.tiles['0,0'];
    return hash ? this.deps.storage.getTile(hash) : null;
  }

  /** Run version operations one after another. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.busy.then(task);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** Create a project (with the default canvases), open it and save it. */
  async create(name: string): Promise<ProjectInfo> {
    const info = await this.deps.storage.createProject(name);
    await this.open(info.id);
    return info;
  }

  private afterOpen(savedAt: number | null = null): void {
    this.scheduler.paused = this.readOnly;
    if (!this.persistent) {
      this.setStatus({ state: 'not-persistent', savedAt: null, message: 'Storage is unavailable: nothing is saved on this device', quota: false });
    } else if (this.readOnly) {
      this.setStatus({
        state: 'read-only',
        savedAt,
        message: 'This project is open in another tab, so it is read-only here: changes made in this tab are not saved.',
        quota: false,
      });
    } else {
      this.setStatus({ state: 'saved', savedAt, message: null, quota: false });
    }
  }

  /** True when another tab has the open project (nothing is saved here). */
  get readOnly(): boolean {
    return this.lock === null;
  }

  // --- projects ---------------------------------------------------------------

  listProjects(): Promise<ProjectInfo[]> {
    return this.deps.storage.listProjects();
  }

  async renameProject(id: ProjectId, name: string): Promise<void> {
    const info = await this.deps.storage.renameProject(id, name);
    if (id === this.project?.id) this.project = info;
  }

  /** Copy a project into a new one (not opened). Refused while another tab is changing it. */
  async duplicateProject(id: ProjectId, name: string): Promise<ProjectInfo> {
    if (id === this.project?.id) {
      if (this.readOnly) throw new Error('This project is open in another tab: duplicate it there');
      await this.scheduler.settle();
      this.scheduler.paused = true; // no commit may replace a manifest while its files are copied
      try {
        return await this.deps.storage.duplicateProject(id, name);
      } finally {
        this.scheduler.paused = false;
        if (this.scheduler.hasUnsavedChanges) this.scheduler.changed(); // strokes made meanwhile
      }
    }
    const lock = await tryLockProject(id);
    if (!lock) throw new Error('That project is open in another tab: close it there first');
    try {
      return await this.deps.storage.duplicateProject(id, name);
    } finally {
      await lock.release();
    }
  }

  /** A project file of a project (saving the open one first). Refused while another tab is changing it. */
  async exportProject(id: ProjectId, includeHistory: boolean): Promise<Uint8Array> {
    if (id === this.project?.id) {
      if (this.readOnly) throw new Error('This project is open in another tab: export it there');
      await this.saveNow();
      return this.deps.storage.exportProject(id, includeHistory);
    }
    const lock = await tryLockProject(id);
    if (!lock) throw new Error('That project is open in another tab: export it there');
    try {
      return await this.deps.storage.exportProject(id, includeHistory);
    } finally {
      await lock.release();
    }
  }

  /** Add a project from a project file, as a new project (not opened). */
  importProject(bytes: Uint8Array): Promise<ProjectInfo> {
    return this.deps.storage.importProject(bytes);
  }

  /**
   * Delete a project and everything in it. Refused while another tab has it
   * open. Deleting the open project opens the most recent other one (or a
   * new one); the result says so, with that project's saved camera.
   */
  async deleteProject(id: ProjectId): Promise<{ reopened: boolean; view: RootManifest['view'] | undefined }> {
    let reopened = false;
    let view: RootManifest['view'] | undefined;
    if (id === this.project?.id) {
      if (this.readOnly) throw new Error('This project is open in another tab: close it there first');
      const next = (await this.listProjects()).filter((p) => p.id !== id).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
      if (next) view = await this.open(next.id);
      else await this.create('Untitled project');
      reopened = true;
    } else if (await isProjectLocked(id)) {
      throw new Error('That project is open in another tab: close it there first');
    }
    await this.deps.storage.deleteProject(id);
    return { reopened, view };
  }

  // --- saving -----------------------------------------------------------------

  /** Save now (e.g. before an operation that must see everything saved). */
  async saveNow(options: SaveOptions = {}): Promise<SaveStats> {
    if (this.readOnly) throw new Error('This project is read-only in this tab');
    await this.scheduler.settle();
    return this.saveWorkingCopy(options);
  }

  private async saveWorkingCopy(options: SaveOptions = {}): Promise<SaveStats> {
    if (this.persistent) this.setStatus({ state: 'saving' });
    try {
      const stats = await this.saver.save(options);
      if (stats.committed && this.saver.lastInfo && this.project?.id === this.saver.lastInfo.id) this.project = this.saver.lastInfo;
      if (this.persistent) {
        const state = this.scheduler.hasUnsavedChanges ? 'unsaved' : 'saved';
        this.setStatus({ state, savedAt: stats.committed ? Date.now() : this.status.savedAt, message: null, quota: false });
      }
      // A preview that wasn't up to date (or was skipped) is saved by another save shortly after.
      if (this.saver.previewsDirty.size > 0 && document.visibilityState === 'visible') this.scheduler.changed();
      this.onSaved?.(stats);
      return stats;
    } catch (error) {
      const quota = isQuotaError(error);
      const message = quota
        ? QUOTA_MESSAGE
        : `Could not save: ${error instanceof Error ? error.message : String(error)}`;
      console.error('Save failed:', error);
      this.setStatus({ state: 'error', message, quota });
      throw error;
    }
  }

  private setStatus(change: Partial<SaveStatus>): void {
    this.status = { ...this.status, ...change };
    this.onStatus?.(this.status);
  }
}
