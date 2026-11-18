import { HISTORY_BUDGET_BYTES, TILE_BYTES } from '../config';
import { Editor } from '../document/editor';
import { PaintDocument, setLayerTile, type CanvasId } from '../document/paintDocument';
import type { TileSlot } from '../document/tiles';
import { TileStore } from '../document/tileStore';
import type { Change, Command, CommandContext } from '../history/command';
import { History } from '../history/history';

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
    this.ctx = { canvas: (id) => this.canvas(id) };
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
    this.canvasCounter++;
    const doc = new PaintDocument(`canvas-${this.canvasCounter}`, this.store, size, name ?? `Canvas ${this.canvasCounter}`);
    doc.insertLayer(doc.createLayer(), 0);
    return doc;
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
