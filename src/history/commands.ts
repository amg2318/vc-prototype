import type { RGB } from '../document/blend';
import {
  releaseAllTiles,
  setLayerTile,
  type CanvasId,
  type LayerId,
  type LayerProps,
  type RasterLayer,
} from '../document/paintDocument';
import type { TileKey, TileSlot } from '../document/tiles';
import type { TileStore } from '../document/tileStore';
import type { Change, Command, CommandContext } from './command';

/** Layer and canvas commands. Each one is small and only does one thing. */

function layerChange(canvasId: CanvasId, layer: RasterLayer, extra: Partial<Change> = {}): Change {
  return { canvasId, tiles: [...layer.tiles.keys()], layers: [layer.id], structure: true, ...extra };
}

/** Remove every entry whose slot is `slot`, releasing its reference. */
function forgetSlotInMap(store: TileStore, tiles: Map<TileKey, TileSlot>, slot: TileSlot): void {
  for (const [key, s] of tiles) {
    if (s === slot) {
      tiles.delete(key);
      store.release(slot);
    }
  }
}

// --- strokes ---------------------------------------------------------------

export interface TileChange {
  key: TileKey;
  /** Slot before the stroke (null = no tile). The command holds a reference. */
  before: TileSlot | null;
  /** Slot after the stroke (null = no tile). The command holds a reference. */
  after: TileSlot | null;
}

/**
 * A brush or eraser stroke. Stores only the tiles it changed, as references
 * to the immutable before/after tile slots, so undo and redo are pointer swaps.
 * The caller passes in references it already owns (one per non-null slot).
 */
export class StrokeCommand implements Command {
  constructor(
    readonly canvasId: CanvasId,
    readonly layerId: LayerId,
    readonly changes: TileChange[],
    readonly label: string,
  ) {}

  apply(ctx: CommandContext): Change {
    return this.set(ctx, 'after');
  }

  revert(ctx: CommandContext): Change {
    return this.set(ctx, 'before');
  }

  private set(ctx: CommandContext, which: 'before' | 'after'): Change {
    const doc = ctx.canvas(this.canvasId);
    const layer = doc.layer(this.layerId);
    for (const change of this.changes) setLayerTile(doc.store, layer, change.key, change[which]);
    return {
      canvasId: this.canvasId,
      tiles: this.changes.map((c) => c.key),
      layers: [this.layerId],
      structure: false,
    };
  }

  dispose(ctx: CommandContext): void {
    const store = ctx.canvas(this.canvasId).store;
    for (const c of this.changes) {
      if (c.before !== null) store.release(c.before);
      if (c.after !== null) store.release(c.after);
    }
  }

  forgetEmptySlot(ctx: CommandContext, slot: TileSlot): void {
    const store = ctx.canvas(this.canvasId).store;
    for (const c of this.changes) {
      if (c.before === slot) {
        c.before = null;
        store.release(slot);
      }
      if (c.after === slot) {
        c.after = null;
        store.release(slot);
      }
    }
  }
}

// --- layer list ------------------------------------------------------------

export class AddLayerCommand implements Command {
  readonly label: string = 'Add layer';
  constructor(
    readonly canvasId: CanvasId,
    private readonly layer: RasterLayer,
    private readonly index: number,
  ) {}

  apply(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).insertLayer(this.layer, this.index);
    return layerChange(this.canvasId, this.layer, { select: this.layer.id });
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).removeLayer(this.layer.id);
    return layerChange(this.canvasId, this.layer);
  }

  dispose(ctx: CommandContext, applied: boolean): void {
    // When undone, the layer is outside the document and owned by this command.
    if (!applied) releaseAllTiles(ctx.canvas(this.canvasId).store, this.layer.tiles);
  }

  forgetEmptySlot(ctx: CommandContext, slot: TileSlot): void {
    if (!ctx.canvas(this.canvasId).hasLayer(this.layer.id)) {
      forgetSlotInMap(ctx.canvas(this.canvasId).store, this.layer.tiles, slot);
    }
  }
}

/** Duplicates share the original's tile slots (extra references, no pixel copies). */
export class DuplicateLayerCommand extends AddLayerCommand {
  override readonly label = 'Duplicate layer';
}

export class DeleteLayerCommand implements Command {
  readonly label = 'Delete layer';
  private index = -1;
  constructor(
    readonly canvasId: CanvasId,
    private readonly layer: RasterLayer,
  ) {}

  apply(ctx: CommandContext): Change {
    this.index = ctx.canvas(this.canvasId).removeLayer(this.layer.id).index;
    return layerChange(this.canvasId, this.layer);
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).insertLayer(this.layer, this.index);
    return layerChange(this.canvasId, this.layer, { select: this.layer.id });
  }

  dispose(ctx: CommandContext, applied: boolean): void {
    if (applied) releaseAllTiles(ctx.canvas(this.canvasId).store, this.layer.tiles);
  }

  forgetEmptySlot(ctx: CommandContext, slot: TileSlot): void {
    // Only reachable while deleted; a layer in the document is handled by the editor.
    if (!ctx.canvas(this.canvasId).hasLayer(this.layer.id)) {
      forgetSlotInMap(ctx.canvas(this.canvasId).store, this.layer.tiles, slot);
    }
  }
}

export class MoveLayerCommand implements Command {
  readonly label = 'Move layer';
  constructor(
    readonly canvasId: CanvasId,
    readonly layerId: LayerId,
    private readonly from: number,
    private readonly to: number,
  ) {}

  apply(ctx: CommandContext): Change {
    return this.move(ctx, this.from, this.to);
  }

  revert(ctx: CommandContext): Change {
    return this.move(ctx, this.to, this.from);
  }

  private move(ctx: CommandContext, from: number, to: number): Change {
    const doc = ctx.canvas(this.canvasId);
    const [layer] = doc.layers.splice(from, 1);
    doc.layers.splice(to, 0, layer!);
    return layerChange(this.canvasId, layer!, { layers: [] });
  }

  dispose(): void {}
}

// --- layer properties ------------------------------------------------------

export class RenameLayerCommand implements Command {
  readonly label = 'Rename layer';
  constructor(
    readonly canvasId: CanvasId,
    private readonly layerId: LayerId,
    private readonly before: string,
    private readonly after: string,
  ) {}

  apply(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).layer(this.layerId).name = this.after;
    return { canvasId: this.canvasId, tiles: [], layers: [], structure: true };
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).layer(this.layerId).name = this.before;
    return { canvasId: this.canvasId, tiles: [], layers: [], structure: true };
  }

  dispose(): void {}
}

/**
 * Opacity, visibility and blend mode. Consecutive commands with the same
 * `mergeKey` (e.g. one slider drag) collapse into one undo step.
 */
export class SetLayerPropsCommand implements Command {
  readonly label: string;
  constructor(
    readonly canvasId: CanvasId,
    readonly layerId: LayerId,
    private readonly before: Partial<LayerProps>,
    private after: Partial<LayerProps>,
    readonly mergeKey: string | null = null,
  ) {
    const which = Object.keys(after).join(', ');
    this.label = `Layer ${which}`;
  }

  apply(ctx: CommandContext): Change {
    return this.set(ctx, this.after);
  }

  revert(ctx: CommandContext): Change {
    return this.set(ctx, this.before);
  }

  private set(ctx: CommandContext, props: Partial<LayerProps>): Change {
    const layer = ctx.canvas(this.canvasId).layer(this.layerId);
    Object.assign(layer, props);
    return layerChange(this.canvasId, layer, { layers: [] });
  }

  mergeWith(next: Command): boolean {
    if (
      !(next instanceof SetLayerPropsCommand) ||
      this.mergeKey === null ||
      next.mergeKey !== this.mergeKey ||
      next.layerId !== this.layerId
    ) {
      return false;
    }
    this.after = { ...this.after, ...next.after };
    return true;
  }

  dispose(): void {}
}

export class ClearLayerCommand implements Command {
  readonly label = 'Clear layer';
  /** Tiles taken out of the layer while applied; owned by this command. */
  private readonly removed = new Map<TileKey, TileSlot>();
  constructor(
    readonly canvasId: CanvasId,
    private readonly layerId: LayerId,
  ) {}

  apply(ctx: CommandContext): Change {
    const layer = ctx.canvas(this.canvasId).layer(this.layerId);
    for (const [k, s] of layer.tiles) this.removed.set(k, s);
    layer.tiles.clear();
    return this.change([...this.removed.keys()]);
  }

  revert(ctx: CommandContext): Change {
    const layer = ctx.canvas(this.canvasId).layer(this.layerId);
    for (const [k, s] of this.removed) layer.tiles.set(k, s);
    const keys = [...this.removed.keys()];
    this.removed.clear();
    return this.change(keys);
  }

  private change(tiles: TileKey[]): Change {
    return { canvasId: this.canvasId, tiles, layers: [this.layerId], structure: false };
  }

  dispose(ctx: CommandContext, applied: boolean): void {
    if (applied) releaseAllTiles(ctx.canvas(this.canvasId).store, this.removed);
  }

  forgetEmptySlot(ctx: CommandContext, slot: TileSlot): void {
    forgetSlotInMap(ctx.canvas(this.canvasId).store, this.removed, slot);
  }
}

// --- canvas ------------------------------------------------------------------

/** Show or hide the paper (background). */
export class SetPaperVisibleCommand implements Command {
  readonly label: string;
  constructor(
    readonly canvasId: CanvasId,
    private readonly visible: boolean,
  ) {
    this.label = visible ? 'Show background' : 'Hide background';
  }

  apply(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).paperVisible = this.visible;
    return { canvasId: this.canvasId, tiles: 'all', layers: [], structure: true };
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).paperVisible = !this.visible;
    return { canvasId: this.canvasId, tiles: 'all', layers: [], structure: true };
  }

  dispose(): void {}
}

export class SetPaperCommand implements Command {
  readonly label = 'Paper colour';
  constructor(
    readonly canvasId: CanvasId,
    private readonly before: RGB,
    private readonly after: RGB,
  ) {}

  apply(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).paper = [...this.after];
    return { canvasId: this.canvasId, tiles: 'all', layers: [], structure: true };
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).paper = [...this.before];
    return { canvasId: this.canvasId, tiles: 'all', layers: [], structure: true };
  }

  dispose(): void {}
}
