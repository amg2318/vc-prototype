import { HISTORY_BUDGET_BYTES, MAX_LAYERS, TILE_BYTES } from '../config';
import type { Change, Command, CommandContext } from '../history/command';
import {
  AddLayerCommand,
  ClearLayerCommand,
  DeleteLayerCommand,
  DuplicateLayerCommand,
  MoveLayerCommand,
  RenameLayerCommand,
  SetLayerPropsCommand,
  SetPaperCommand,
  StrokeCommand,
  type TileChange,
} from '../history/commands';
import { History } from '../history/history';
import type { RGB } from './blend';
import { PaintDocument, setLayerTile, type LayerId, type LayerProps } from './paintDocument';
import type { TileKey, TileSlot } from './tiles';
import { TileStore } from './tileStore';

export type StrokeMode = 'paint' | 'erase';

/** A tile the GPU must produce when a stroke is committed: `dst = src + stroke mask`. */
export interface MergeJob {
  key: TileKey;
  /** Existing tile (null = start from transparent). */
  src: TileSlot | null;
  /** Freshly allocated slot to write. */
  dst: TileSlot;
}

export interface EditorStats {
  layers: number;
  tileEntries: number;
  usedSlots: number;
  capacitySlots: number;
  pages: number;
  historySteps: number;
  redoSteps: number;
  historyBytes: number;
}

/**
 * The single entry point for changing a document. Every change goes through
 * the history as a command, and listeners hear about what changed so the app
 * can recomposite tiles and refresh the UI. GPU-free, so it is unit-tested.
 */
export class Editor {
  readonly doc: PaintDocument;
  readonly history: History;
  activeLayerId: LayerId;
  private listeners: ((change: Change) => void)[] = [];
  private readonly ctx: CommandContext;

  constructor(store = new TileStore(), historyBudgetBytes = HISTORY_BUDGET_BYTES, canvasId = 'main') {
    this.doc = new PaintDocument(canvasId, store);
    this.ctx = { canvas: () => this.doc };
    this.history = new History(this.ctx, historyBudgetBytes, () => this.historyBytes());
    const first = this.doc.createLayer();
    this.doc.insertLayer(first, 0); // the initial layer is not an undoable step
    this.activeLayerId = first.id;
  }

  get store(): TileStore {
    return this.doc.store;
  }

  get activeLayer() {
    return this.doc.layer(this.activeLayerId);
  }

  onChange(listener: (change: Change) => void): void {
    this.listeners.push(listener);
  }

  /** Bytes of tile memory kept alive only by undo/redo history. */
  historyBytes(): number {
    return (this.store.usedSlots - this.doc.usedSlotCount()) * TILE_BYTES;
  }

  stats(): EditorStats {
    return {
      layers: this.doc.layers.length,
      tileEntries: this.doc.tileEntryCount(),
      usedSlots: this.store.usedSlots,
      capacitySlots: this.store.capacity,
      pages: this.store.pagesNeeded,
      historySteps: this.history.undoCount,
      redoSteps: this.history.redoCount,
      historyBytes: this.historyBytes(),
    };
  }

  setActiveLayer(id: LayerId): void {
    if (!this.doc.hasLayer(id) || id === this.activeLayerId) return;
    this.activeLayerId = id;
    this.emit({ canvasId: this.doc.id, tiles: [], layers: [], structure: true });
  }

  // --- history ----------------------------------------------------------------

  undo(): boolean {
    const change = this.history.undo();
    if (change) this.emit(change);
    return change !== null;
  }

  redo(): boolean {
    const change = this.history.redo();
    if (change) this.emit(change);
    return change !== null;
  }

  private execute(command: Command): void {
    this.emit(this.history.execute(command));
  }

  private emit(change: Change): void {
    if (change.select && this.doc.hasLayer(change.select)) this.activeLayerId = change.select;
    if (!this.doc.hasLayer(this.activeLayerId)) {
      // The active layer went away (undo of "add", delete): pick the nearest one.
      this.activeLayerId = this.doc.layers[Math.max(0, this.doc.layers.length - 1)]!.id;
    }
    for (const l of this.listeners) l(change);
  }

  // --- strokes ----------------------------------------------------------------

  /**
   * Allocate tiles for a finished stroke on `layerId` that touched `keys`, and
   * record it in the history. Returns the GPU work to do, or null if the tile
   * pool is full even after dropping all undo history.
   */
  commitStroke(layerId: LayerId, keys: Iterable<TileKey>, mode: StrokeMode): MergeJob[] | null {
    const layer = this.doc.layer(layerId);
    // Erasing a tile that doesn't exist changes nothing.
    const affected = [...keys].filter((k) => mode === 'paint' || layer.tiles.has(k));
    if (affected.length === 0) return [];

    while (this.store.freeSlots < affected.length && this.history.dropOldest()) {
      // Make room by forgetting the oldest undo steps.
    }
    if (this.store.freeSlots < affected.length) return null;

    const jobs: MergeJob[] = [];
    const changes: TileChange[] = [];
    for (const key of affected) {
      const before = layer.tiles.get(key) ?? null;
      if (before !== null) this.store.retain(before); // the command's reference
      const after = this.store.allocate()!; // the allocation's reference goes to the command
      jobs.push({ key, src: before, dst: after });
      changes.push({ key, before, after });
    }
    const label = mode === 'paint' ? 'Brush stroke' : 'Eraser stroke';
    this.execute(new StrokeCommand(this.doc.id, layerId, changes, label));
    return jobs;
  }

  /**
   * The GPU found these tiles fully transparent (after erasing). Drop them
   * everywhere: "empty tile" and "no tile" look the same, and no tile costs
   * no memory. `generation` guards against a slot reused in the meantime.
   */
  forgetEmptyTiles(found: { slot: TileSlot; generation: number }[]): void {
    for (const { slot, generation } of found) {
      if (this.store.refCount(slot) === 0 || this.store.generation(slot) !== generation) continue;
      for (const layer of this.doc.layers) {
        for (const [key, s] of layer.tiles) if (s === slot) setLayerTile(this.store, layer, key, null);
      }
      this.history.forEachCommand((c) => c.forgetEmptySlot?.(this.ctx, slot));
    }
  }

  // --- layers -----------------------------------------------------------------

  get canAddLayer(): boolean {
    return this.doc.layers.length < MAX_LAYERS;
  }

  /** Adds a layer above the active one. */
  addLayer(): boolean {
    if (!this.canAddLayer) return false;
    const index = this.doc.indexOf(this.activeLayerId) + 1;
    this.execute(new AddLayerCommand(this.doc.id, this.doc.createLayer(), index));
    return true;
  }

  duplicateLayer(id: LayerId): boolean {
    if (!this.canAddLayer) return false;
    const source = this.doc.layer(id);
    const copy = this.doc.createLayer(`${source.name} copy`);
    Object.assign(copy, source.props());
    for (const [key, slot] of source.tiles) {
      this.store.retain(slot);
      copy.tiles.set(key, slot);
    }
    this.execute(new DuplicateLayerCommand(this.doc.id, copy, this.doc.indexOf(id) + 1));
    return true;
  }

  /** The last remaining layer can't be deleted. */
  deleteLayer(id: LayerId): boolean {
    if (this.doc.layers.length <= 1) return false;
    this.execute(new DeleteLayerCommand(this.doc.id, this.doc.layer(id)));
    return true;
  }

  moveLayer(id: LayerId, toIndex: number): void {
    const from = this.doc.indexOf(id);
    const to = Math.max(0, Math.min(this.doc.layers.length - 1, toIndex));
    if (from < 0 || from === to) return;
    this.execute(new MoveLayerCommand(this.doc.id, id, from, to));
  }

  renameLayer(id: LayerId, name: string): void {
    const layer = this.doc.layer(id);
    const trimmed = name.trim();
    if (!trimmed || trimmed === layer.name) return;
    this.execute(new RenameLayerCommand(this.doc.id, id, layer.name, trimmed));
  }

  /** `mergeKey`: commands with the same key in a row become one undo step (use one per slider drag). */
  setLayerProps(id: LayerId, props: Partial<LayerProps>, mergeKey: string | null = null): void {
    const layer = this.doc.layer(id);
    const before: Partial<LayerProps> = {};
    for (const k of Object.keys(props) as (keyof LayerProps)[]) {
      (before as Record<string, unknown>)[k] = layer[k];
    }
    this.execute(new SetLayerPropsCommand(this.doc.id, id, before, props, mergeKey));
  }

  clearLayer(id: LayerId): void {
    if (this.doc.layer(id).tiles.size === 0) return;
    this.execute(new ClearLayerCommand(this.doc.id, id));
  }

  setPaper(color: RGB): void {
    this.execute(new SetPaperCommand(this.doc.id, [...this.doc.paper], [...color]));
  }
}
