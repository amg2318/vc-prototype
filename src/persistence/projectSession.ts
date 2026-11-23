import { SAVE, TILE_BYTES } from '../config';
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
  private persistent = true;

  constructor(private readonly deps: SessionDeps) {
    const { workspace, renderer, storage } = deps;
    this.hashes = new TileHashes(workspace.store);
    this.backing = new DiskTileBackingStore(storage, this.hashes, workspace.store);
    renderer.useBackingStore(this.backing);
    renderer.onCompositeChanged = (canvasId) => this.saver.previewsDirty.add(canvasId);
    this.saver = new ProjectSaver({
      workspace,
      hashes: this.hashes,
      storage,
      readLayerTiles: (ids) => renderer.readLayerTiles(ids),
      readPreviewTiles: (canvasId) => renderer.readPreviewTiles(canvasId),
      view: () => deps.view(),
    });
    this.scheduler = new AutosaveScheduler(async () => {
      // While the page is hidden, every second counts (it may be closed for good): skip the previews.
      await this.saveWorkingCopy({ skipPreviews: document.visibilityState === 'hidden' });
    }, SAVE.debounceMs);
    workspace.onChange(() => {
      if (this.scheduler.paused) return;
      this.scheduler.changed();
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

  /** Save the current project, then load `id` (with a fresh undo history). */
  async open(id: ProjectId): Promise<RootManifest['view'] | undefined> {
    await this.scheduler.settle();
    const { storage, workspace, renderer } = this.deps;
    const opened = await storage.openProject(id);
    this.project = opened.info;
    localStorage.setItem(LAST_PROJECT_KEY, id);
    const copy = await storage.readProject(null);
    this.scheduler.paused = true; // loading is not a change to save
    if (!copy) {
      // Created but never saved: start it with the default canvases.
      workspace.load(this.deps.newProjectCanvases(workspace), workspace.canvasCounter, null);
      this.saver.remember([], [], null, opened.head);
      this.afterOpen();
      await this.saveNow();
      return undefined;
    }
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
    const recordHashes: ObjectHash[] = copy.manifest.canvases.map((c) => c.record);
    this.saver.remember(copy.records, recordHashes, copy.manifest, opened.head);
    this.afterOpen(opened.head?.updatedAt ?? null);
    return copy.manifest.view;
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

  /** Create a project (with the default canvases), open it and save it. */
  async create(name: string): Promise<ProjectInfo> {
    const info = await this.deps.storage.createProject(name);
    await this.open(info.id);
    return info;
  }

  private afterOpen(savedAt: number | null = null): void {
    this.scheduler.paused = false;
    this.setStatus(
      this.persistent
        ? { state: 'saved', savedAt, message: null, quota: false }
        : { state: 'not-persistent', savedAt: null, message: 'Storage is unavailable: nothing is saved on this device', quota: false },
    );
  }

  // --- saving -----------------------------------------------------------------

  /** Save now (e.g. before an operation that must see everything saved). */
  async saveNow(options: SaveOptions = {}): Promise<SaveStats> {
    await this.scheduler.settle();
    return this.saveWorkingCopy(options);
  }

  private async saveWorkingCopy(options: SaveOptions = {}): Promise<SaveStats> {
    if (this.persistent) this.setStatus({ state: 'saving' });
    try {
      const stats = await this.saver.save(options);
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
        ? 'Storage is full: your latest changes are not saved. Delete old versions or export projects to make room.'
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
