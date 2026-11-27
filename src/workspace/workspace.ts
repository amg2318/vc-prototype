import { HISTORY_BUDGET_BYTES, MAX_CANVAS_SIZE, TILE_BYTES } from '../config';
import { Editor } from '../document/editor';
import { PaintDocument, releaseAllTiles, setLayerTile, type CanvasId } from '../document/paintDocument';
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
  SetBlockCommand,
  SetBlocksCommand,
} from '../history/canvasCommands';
import {
  createBlock,
  emptyBlock,
  fitPlacement,
  linkBlock,
  linkedSource,
  refitBlock,
  type BlockCrop,
  type BlockPlacement,
  type InheritedBlock,
} from '../document/inheritedBlock';
import { InheritanceGraph } from './inheritanceGraph';
import { History } from '../history/history';
import { planResize, retileLayer, type Anchor, type RetileJob } from '../document/retile';
import type { LayerId } from '../document/paintDocument';
import type { Placement } from './coords';
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
  /** Canvases created so far (canvas ids are numbered from it; saved, so ids never repeat). */
  canvasCounter = 0;
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
      canvases: () => this.canvases,
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

  /**
   * Replace every canvas with `docs` (opening a project, or restoring a
   * version). Not undoable: the undo history is cleared first, which also
   * releases the tiles that only history kept alive.
   */
  load(docs: readonly PaintDocument[], canvasCounter: number, activeCanvasId: CanvasId | null): void {
    this.history.clear();
    for (const doc of this.canvases) for (const layer of doc.layers) releaseAllTiles(this.store, layer.tiles);
    this.canvases.length = 0;
    this.detached.clear();
    this.editors.clear();
    for (const doc of docs) this.canvases.push(doc);
    this.canvasCounter = canvasCounter;
    this.activeCanvasId = activeCanvasId !== null && this.hasCanvas(activeCanvasId) ? activeCanvasId : (docs[0]?.id ?? null);
    for (const doc of docs) this.emit({ canvasId: doc.id, tiles: 'all', layers: doc.layers.map((l) => l.id), structure: true, workspace: true });
    if (docs.length === 0) this.emit({ canvasId: '', tiles: [], layers: [], structure: true, workspace: true });
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
    copy.paperVisible = source.paperVisible;
    copy.inherited = source.inherited; // still linked to the same source (blocks are never edited in place)
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
    this.execute(new ResizeCanvasCommand(id, { placement: plan.placement, tiles, blocks: this.blocksAfterResize(doc, plan.placement) }));
    return jobs;
  }

  /**
   * Inherited blocks after `doc` takes `placement`. Its own block stays put in
   * the workspace (or refits, if fitted). Blocks inheriting it refit if fitted;
   * custom ones keep their scale, so the content doesn't jump.
   */
  private blocksAfterResize(doc: PaintDocument, placement: Placement): Map<CanvasId, InheritedBlock | null> {
    const blocks = new Map<CanvasId, InheritedBlock | null>();
    const size = { width: placement.width, height: placement.height };
    const own = doc.inherited;
    if (own) {
      const source = linkedSourceDoc(this, own);
      if (own.placement.mode === 'fit') {
        blocks.set(doc.id, { ...own, placement: fitPlacement(own.crop, source ? sizeOf(source) : own.lastSourceSize, size) });
      } else {
        const dx = doc.x - placement.x;
        const dy = doc.y - placement.y;
        blocks.set(doc.id, { ...own, placement: { ...own.placement, x: own.placement.x + dx, y: own.placement.y + dy } });
      }
    }
    for (const id of this.graph().inheritorsOf(doc.id)) {
      const target = this.canvas(id);
      const block = target.inherited!;
      const placementAfter = block.placement.mode === 'fit' ? fitPlacement(block.crop, size, sizeOf(target)) : block.placement;
      blocks.set(id, { ...block, placement: placementAfter, lastSourceSize: size });
    }
    return blocks;
  }

  // --- inheritance (each operation undoable) ------------------------------------

  /** The arrows between the canvases in the workspace, as they are now. */
  graph(): InheritanceGraph {
    return new InheritanceGraph(this.canvases);
  }

  /** Could `targetId` inherit `sourceId` (both exist, and no cycle)? */
  canConnect(targetId: CanvasId, sourceId: CanvasId): boolean {
    return this.hasCanvas(targetId) && this.hasCanvas(sourceId) && !this.graph().wouldCycle(targetId, sourceId);
  }

  /**
   * Make `targetId` inherit `sourceId`: creates the arrow (and the block, if
   * the canvas has none), retargets an existing arrow, or relinks an empty
   * or missing block. Refused (returns false) if it would create a cycle.
   */
  connect(targetId: CanvasId, sourceId: CanvasId): boolean {
    if (!this.canConnect(targetId, sourceId)) return false;
    const target = this.canvas(targetId);
    const before = target.inherited;
    if (before?.source.kind === 'linked' && before.source.canvasId === sourceId) return true;
    const sourceSize = sizeOf(this.canvas(sourceId));
    const after = before ? linkBlock(before, sourceId, sourceSize, sizeOf(target)) : createBlock(sourceId, sourceSize, sizeOf(target));
    const label = before?.source.kind === 'linked' ? 'Retarget arrow' : before?.source.kind === 'missing' ? 'Relink source' : 'Create arrow';
    this.execute(new SetBlockCommand(targetId, before, after, label));
    return true;
  }

  /**
   * Move the head of the arrow into `fromId` to `toId`: `toId` inherits the
   * same source (keeping its own block settings, if it had a block), and
   * `fromId`'s block is left empty. One undo step.
   */
  moveArrowHead(fromId: CanvasId, toId: CanvasId): boolean {
    const from = this.canvas(fromId);
    const sourceId = from.inherited ? linkedSource(from.inherited) : null;
    if (sourceId === null || fromId === toId || !this.canConnect(toId, sourceId)) return false;
    const to = this.canvas(toId);
    const sourceSize = sizeOf(this.canvas(sourceId));
    const linked = to.inherited ? linkBlock(to.inherited, sourceId, sourceSize, sizeOf(to)) : createBlock(sourceId, sourceSize, sizeOf(to));
    this.execute(
      new SetBlocksCommand(
        [
          { canvasId: fromId, before: from.inherited, after: emptyBlock(from.inherited!) },
          { canvasId: toId, before: to.inherited, after: linked },
        ],
        'Move arrow',
      ),
    );
    return true;
  }

  /**
   * Delete the arrow into `targetId` (or its broken stub, if the source was
   * deleted): the block stays, empty, with its settings.
   */
  deleteArrow(targetId: CanvasId): void {
    const before = this.canvas(targetId).inherited;
    if (before?.source.kind !== 'linked' && before?.source.kind !== 'missing') return;
    this.execute(new SetBlockCommand(targetId, before, emptyBlock(before), 'Delete arrow'));
  }

  /** Delete the inherited block and all its settings. */
  removeBlock(targetId: CanvasId): void {
    const before = this.canvas(targetId).inherited;
    if (before) this.execute(new SetBlockCommand(targetId, before, null, 'Remove inherited block'));
  }

  /** "Refit": centre the block inside the canvas again. */
  refitBlock(targetId: CanvasId): void {
    const target = this.canvas(targetId);
    const before = target.inherited;
    if (!before) return;
    const source = linkedSourceDoc(this, before);
    const after = refitBlock(before, source ? sizeOf(source) : before.lastSourceSize, sizeOf(target));
    this.execute(new SetBlockCommand(targetId, before, after, 'Refit inherited block'));
  }

  /** Move, scale, rotate or flip the block. Its placement becomes custom. */
  placeBlock(targetId: CanvasId, changes: Partial<Omit<BlockPlacement, 'mode'>>, mergeKey: string | null = null): void {
    const before = this.canvas(targetId).inherited;
    if (!before) return;
    this.setBlock(targetId, { placement: { ...before.placement, ...changes, mode: 'custom' } }, 'Transform inherited block', mergeKey);
  }

  /**
   * Crop the block on the canvas: the crop and the centre change together, so
   * what stays visible doesn't move. The placement becomes custom (a fitted
   * block would otherwise refit to the new crop and jump).
   */
  cropBlock(targetId: CanvasId, crop: BlockCrop | undefined, centre: { x: number; y: number }, mergeKey: string | null = null): void {
    const before = this.canvas(targetId).inherited;
    if (!before) return;
    const placement = { ...before.placement, x: centre.x, y: centre.y, mode: 'custom' as const };
    this.setBlock(targetId, { crop, placement }, 'Crop inherited block', mergeKey);
  }

  /**
   * Change other block settings (crop, effects, opacity, blend mode,
   * visibility). A fitted block refits when its crop changes.
   */
  setBlock(
    targetId: CanvasId,
    changes: Partial<Omit<InheritedBlock, 'source' | 'lastSourceSize'>>,
    label = 'Inherited block settings',
    mergeKey: string | null = null,
  ): void {
    const target = this.canvas(targetId);
    const before = target.inherited;
    if (!before) return;
    let after: InheritedBlock = { ...before, ...changes };
    if ('crop' in changes && after.placement.mode === 'fit') {
      const source = linkedSourceDoc(this, after);
      after = refitBlock(after, source ? sizeOf(source) : after.lastSourceSize, sizeOf(target));
    }
    this.execute(new SetBlockCommand(targetId, before, after, label, mergeKey));
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

function sizeOf(doc: PaintDocument): { width: number; height: number } {
  return { width: doc.width, height: doc.height };
}

/** The canvas a block is linked to, if it is linked to one in the workspace. */
function linkedSourceDoc(ws: Workspace, block: InheritedBlock): PaintDocument | null {
  return block.source.kind === 'linked' && ws.hasCanvas(block.source.canvasId) ? ws.canvas(block.source.canvasId) : null;
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
