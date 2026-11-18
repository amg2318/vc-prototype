import { HISTORY_BUDGET_BYTES, MAX_CANVAS_SIZE, TILE_BYTES } from '../config';
import { Editor } from '../document/editor';
import { PaintDocument, setLayerTile, type CanvasId } from '../document/paintDocument';
import type { TileSlot } from '../document/tiles';
import { TileStore } from '../document/tileStore';
import type { Change, Command, CommandContext } from '../history/command';
import {
  AddCanvasCommand,
  DeleteCanvasCommand,
  MoveCanvasCommand,
  RenameCanvasCommand,
  ReorderCanvasCommand,
  ResizeCanvasCommand,
} from '../history/canvasCommands';
import { History } from '../history/history';
import { planResize, retileLayer, type Anchor, type RetileJob } from '../document/retile';
import type { LayerId } from '../document/paintDocument';
import type { TileKey } from '../document/tiles';

export interface WorkspaceStats {
  canvases: number;
  usedSlots: number;
  capacitySlots: number;
  historySteps: number;
  redoSteps: number;
  historyBytes: number;
}

/**
 * The workspace: every canvas, in z-order, sharing one tile store and one
 * undo history. All changes go through `execute` as commands; listeners hear
 * about each change (which canvas, which tiles) so the app can redraw.
 *
 * GPU-free, so it is unit-tested.
 */
export class Workspace {
  readonly store: TileStore;
  readonly history: History;
  /** Canvases in z-order: index 0 is at the back, the last one in front. */
  readonly canvases: PaintDocument[] = [];
  /**
   * Canvases removed from the workspace (deleted) but still reachable by undo.
   * Commands look canvases up by id, so these must stay findable.
   */
  private readonly detached = new Map<CanvasId, PaintDocument>();
  private readonly editors = new Map<CanvasId, Editor>();
  private listeners: ((change: Change) => void)[] = [];
  private canvasCounter = 0;
  readonly ctx: CommandContext;
  activeCanvasId: CanvasId | null = null;

  constructor(store = new TileStore(), historyBudgetBytes = HISTORY_BUDGET_BYTES) {
    this.store = store;
    this.ctx = {
      canvas: (id) => this.canvas(id),
      attachCanvas: (doc, index) => this.attachCanvas(doc, index),
      detachCanvas: (id) => this.detachCanvas(id),
      forgetCanvas: (id) => this.forgetCanvas(id),
      canvasIndex: (id) => this.canvases.findIndex((c) => c.id === id),
    };
    this.history = new History(this.ctx, historyBudgetBytes, () => this.historyBytes());
  }

  // --- canvases ---------------------------------------------------------------

  /** A canvas by id, including deleted canvases that undo can bring back. */
  canvas(id: CanvasId): PaintDocument {
    const doc = this.canvases.find((c) => c.id === id) ?? this.detached.get(id);
    if (!doc) throw new Error(`No canvas ${id}`);
    return doc;
  }

  /** True if the canvas is in the workspace (not deleted). */
  hasCanvas(id: CanvasId): boolean {
    return this.canvases.some((c) => c.id === id);
  }

  /** The editing facade for one canvas (layers, strokes, active layer). */
  editor(id: CanvasId): Editor {
    let editor = this.editors.get(id);
    if (!editor) {
      editor = new Editor(this, this.canvas(id));
      this.editors.set(id, editor);
    }
    return editor;
  }

  get activeEditor(): Editor | null {
    return this.activeCanvasId !== null && this.hasCanvas(this.activeCanvasId) ? this.editor(this.activeCanvasId) : null;
  }

  /** A new, empty canvas object (not yet in the workspace) with one layer. */
  newCanvas(size: { width: number; height: number }, name?: string): PaintDocument {
    const id = this.nextCanvasId();
    const doc = new PaintDocument(id, this.store, size, name ?? `Canvas ${this.canvasCounter}`);
    doc.insertLayer(doc.createLayer(), 0);
    return doc;
  }

  private nextCanvasId(): CanvasId {
    this.canvasCounter++;
    return `canvas-${this.canvasCounter}`;
  }

  /** Put a canvas into the workspace at z-index `index` (used by commands and setup). */
  attachCanvas(doc: PaintDocument, index = this.canvases.length): void {
    this.detached.delete(doc.id);
    this.canvases.splice(index, 0, doc);
  }

  /** Take a canvas out of the workspace, keeping it findable for undo. Returns its z-index. */
  detachCanvas(id: CanvasId): number {
    const index = this.canvases.findIndex((c) => c.id === id);
    if (index < 0) throw new Error(`No canvas ${id}`);
    const [doc] = this.canvases.splice(index, 1);
    this.detached.set(id, doc!);
    if (this.activeCanvasId === id) this.activeCanvasId = null;
    return index;
  }

  /** A deleted canvas left the history for good: forget it. Its tiles must already be released. */
  forgetCanvas(id: CanvasId): void {
    this.detached.delete(id);
    this.editors.delete(id);
  }

  // --- canvas operations (each one undoable) ----------------------------------

  /** Create an empty canvas in front of all others, and select it. */
  createCanvas(size: { width: number; height: number }, at: { x: number; y: number }, name?: string): PaintDocument {
    const doc = this.newCanvas(clampSize(size), name);
    doc.x = Math.round(at.x);
    doc.y = Math.round(at.y);
    this.execute(new AddCanvasCommand(doc, this.canvases.length));
    return doc;
  }

  /** Copy a canvas (sharing its tiles) and place it to the right of the original. */
  duplicateCanvas(id: CanvasId): PaintDocument {
    const source = this.canvas(id);
    const copy = new PaintDocument(this.nextCanvasId(), this.store, source, `${source.name} copy`);
    copy.x = source.x + source.width + 100;
    copy.y = source.y;
    copy.paper = [...source.paper];
    for (const layer of source.layers) {
      const l = copy.createLayer(layer.name);
      Object.assign(l, layer.props());
      for (const [key, slot] of layer.tiles) {
        this.store.retain(slot);
        l.tiles.set(key, slot);
      }
      copy.insertLayer(l, copy.layers.length);
    }
    this.execute(new AddCanvasCommand(copy, this.canvases.length, 'Duplicate canvas'));
    return copy;
  }

  deleteCanvas(id: CanvasId): void {
    if (this.hasCanvas(id)) this.execute(new DeleteCanvasCommand(id));
  }

  /** `mergeKey`: moves with the same key in a row (one drag) become one undo step. */
  moveCanvas(id: CanvasId, x: number, y: number, mergeKey: string | null = null): void {
    const doc = this.canvas(id);
    const to = { x: Math.round(x), y: Math.round(y) };
    if (to.x === doc.x && to.y === doc.y) return;
    this.execute(new MoveCanvasCommand(id, { x: doc.x, y: doc.y }, to, mergeKey));
  }

  renameCanvas(id: CanvasId, name: string): void {
    const doc = this.canvas(id);
    const trimmed = name.trim();
    if (trimmed && trimmed !== doc.name) this.execute(new RenameCanvasCommand(id, doc.name, trimmed));
  }

  bringToFront(id: CanvasId): void {
    const from = this.canvases.findIndex((c) => c.id === id);
    const to = this.canvases.length - 1;
    if (from >= 0 && from !== to) this.execute(new ReorderCanvasCommand(id, from, to));
  }

  /**
   * Change a canvas's dimensions around `anchor` (content stays put in the
   * workspace). Returns the GPU work that produces the new tiles, or null if
   * the tile pool is full even after dropping all undo history.
   */
  resizeCanvas(id: CanvasId, size: { width: number; height: number }, anchor: Anchor): RetileJob[] | null {
    const doc = this.canvas(id);
    const { width, height } = clampSize(size);
    if (width === doc.width && height === doc.height) return [];
    const plan = planResize(doc.placement, width, height, anchor);
    const perLayer = doc.layers.map((layer) => ({ layer, ...retileLayer(layer.tiles, doc.placement, plan) }));
    const needed = perLayer.reduce((n, l) => n + l.jobs.length, 0);
    while (this.store.freeSlots < needed && this.history.dropOldest()) {
      // Make room by forgetting the oldest undo steps.
    }
    if (this.store.freeSlots < needed) return null;

    const jobs: RetileJob[] = [];
    const tiles = new Map<LayerId, Map<TileKey, TileSlot>>();
    for (const { layer, reused, jobs: layerJobs } of perLayer) {
      const next = new Map<TileKey, TileSlot>();
      for (const [key, slot] of reused) {
        this.store.retain(slot);
        next.set(key, slot);
      }
      for (const job of layerJobs) {
        const dst = this.store.allocate()!;
        next.set(job.key, dst);
        jobs.push({ ...job, dst });
      }
      tiles.set(layer.id, next);
    }
    this.execute(new ResizeCanvasCommand(id, { placement: plan.placement, tiles }));
    return jobs;
  }

  setActiveCanvas(id: CanvasId | null): void {
    if (id === this.activeCanvasId || (id !== null && !this.hasCanvas(id))) return;
    this.activeCanvasId = id;
    this.emit({ canvasId: id ?? '', tiles: [], layers: [], structure: true });
  }

  // --- changes and history ----------------------------------------------------

  onChange(listener: (change: Change) => void): void {
    this.listeners.push(listener);
  }

  execute(command: Command): void {
    this.emit(this.history.execute(command));
  }

  undo(): Change | null {
    const change = this.history.undo();
    if (change) this.emit(change);
    return change;
  }

  redo(): Change | null {
    const change = this.history.redo();
    if (change) this.emit(change);
    return change;
  }

  /** Report a change that didn't go through the history (e.g. selecting a layer). */
  emit(change: Change): void {
    if (change.selectCanvas && this.hasCanvas(change.selectCanvas)) this.activeCanvasId = change.selectCanvas;
    if (this.hasCanvas(change.canvasId)) this.editor(change.canvasId).noteChange(change);
    for (const l of this.listeners) l(change);
  }

  // --- memory -----------------------------------------------------------------

  /** Distinct tile slots used by canvases in the workspace. */
  usedSlotCount(): number {
    const slots = new Set<TileSlot>();
    for (const c of this.canvases) c.collectSlots(slots);
    return slots.size;
  }

  /** Bytes of tile memory kept alive only by undo/redo history. */
  historyBytes(): number {
    return (this.store.usedSlots - this.usedSlotCount()) * TILE_BYTES;
  }

  stats(): WorkspaceStats {
    return {
      canvases: this.canvases.length,
      usedSlots: this.store.usedSlots,
      capacitySlots: this.store.capacity,
      historySteps: this.history.undoCount,
      redoSteps: this.history.redoCount,
      historyBytes: this.historyBytes(),
    };
  }

  /**
   * The GPU found these tiles fully transparent (after erasing). Drop them
   * from every canvas and every undo step: "empty tile" and "no tile" look the
   * same, and no tile costs no memory. `generation` guards against a slot
   * reused in the meantime.
   */
  forgetEmptyTiles(found: { slot: TileSlot; generation: number }[]): void {
    for (const { slot, generation } of found) {
      if (this.store.refCount(slot) === 0 || this.store.generation(slot) !== generation) continue;
      for (const doc of [...this.canvases, ...this.detached.values()]) {
        for (const layer of doc.layers) {
          for (const [key, s] of layer.tiles) if (s === slot) setLayerTile(this.store, layer, key, null);
        }
      }
      this.history.forEachCommand((c) => c.forgetEmptySlot?.(this.ctx, slot));
    }
  }
}

function clampSize(size: { width: number; height: number }): { width: number; height: number } {
  const clamp = (v: number): number => Math.max(1, Math.min(MAX_CANVAS_SIZE, Math.round(v)));
  return { width: clamp(size.width), height: clamp(size.height) };
}

/** A workspace with one canvas, and that canvas's editor (tests and simple setups). */
export function singleCanvasEditor(
  store = new TileStore(),
  historyBudgetBytes = HISTORY_BUDGET_BYTES,
  size?: { width: number; height: number },
): Editor {
  const workspace = new Workspace(store, historyBudgetBytes);
  const doc = workspace.newCanvas(size ?? { width: 4096, height: 4096 });
  workspace.attachCanvas(doc);
  workspace.activeCanvasId = doc.id;
  return workspace.editor(doc.id);
}
