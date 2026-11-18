import { releaseAllTiles, type CanvasId, type LayerId, type PaintDocument } from '../document/paintDocument';
import type { TileKey, TileSlot } from '../document/tiles';
import type { Placement } from '../workspace/coords';
import type { Change, Command, CommandContext } from './command';

/** Workspace-level commands: one per canvas operation. */

function canvasChange(canvasId: CanvasId, extra: Partial<Change> = {}): Change {
  return { canvasId, tiles: 'all', layers: [], structure: true, workspace: true, ...extra };
}

function releaseCanvasTiles(doc: PaintDocument): void {
  for (const layer of doc.layers) releaseAllTiles(doc.store, layer.tiles);
}

/** Adds a new canvas (also used for duplicates, which share their source's tiles). */
export class AddCanvasCommand implements Command {
  constructor(
    private readonly doc: PaintDocument,
    private readonly index: number,
    readonly label: string = 'New canvas',
  ) {}

  get canvasId(): CanvasId {
    return this.doc.id;
  }

  apply(ctx: CommandContext): Change {
    ctx.attachCanvas(this.doc, this.index);
    return canvasChange(this.doc.id, { selectCanvas: this.doc.id });
  }

  revert(ctx: CommandContext): Change {
    ctx.detachCanvas(this.doc.id);
    return canvasChange(this.doc.id);
  }

  dispose(ctx: CommandContext, applied: boolean): void {
    // Undone and then dropped from the redo stack: the canvas is gone for good.
    if (!applied) {
      releaseCanvasTiles(this.doc);
      ctx.forgetCanvas(this.doc.id);
    }
  }
}

export class DeleteCanvasCommand implements Command {
  readonly label = 'Delete canvas';
  private index = 0;
  private doc: PaintDocument | null = null;

  constructor(readonly canvasId: CanvasId) {}

  apply(ctx: CommandContext): Change {
    this.doc = ctx.canvas(this.canvasId);
    this.index = ctx.detachCanvas(this.canvasId);
    return canvasChange(this.canvasId);
  }

  revert(ctx: CommandContext): Change {
    ctx.attachCanvas(this.doc!, this.index);
    return canvasChange(this.canvasId, { selectCanvas: this.canvasId });
  }

  dispose(ctx: CommandContext, applied: boolean): void {
    // Dropped while deleted: nothing can bring the canvas back.
    if (applied && this.doc) {
      releaseCanvasTiles(this.doc);
      ctx.forgetCanvas(this.canvasId);
    }
  }
}

/** Move a canvas in the workspace. Commands with the same `mergeKey` in a row (one drag) become one step. */
export class MoveCanvasCommand implements Command {
  readonly label = 'Move canvas';
  constructor(
    readonly canvasId: CanvasId,
    private readonly from: { x: number; y: number },
    private to: { x: number; y: number },
    readonly mergeKey: string | null = null,
  ) {}

  apply(ctx: CommandContext): Change {
    Object.assign(ctx.canvas(this.canvasId), this.to);
    return canvasChange(this.canvasId, { tiles: [] });
  }

  revert(ctx: CommandContext): Change {
    Object.assign(ctx.canvas(this.canvasId), this.from);
    return canvasChange(this.canvasId, { tiles: [] });
  }

  dispose(): void {}

  mergeWith(next: Command): boolean {
    if (!(next instanceof MoveCanvasCommand) || this.mergeKey === null || next.mergeKey !== this.mergeKey) return false;
    if (next.canvasId !== this.canvasId) return false;
    this.to = next.to;
    return true;
  }
}

export class RenameCanvasCommand implements Command {
  readonly label = 'Rename canvas';
  constructor(
    readonly canvasId: CanvasId,
    private readonly before: string,
    private readonly after: string,
  ) {}

  apply(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).name = this.after;
    return canvasChange(this.canvasId, { tiles: [] });
  }

  revert(ctx: CommandContext): Change {
    ctx.canvas(this.canvasId).name = this.before;
    return canvasChange(this.canvasId, { tiles: [] });
  }

  dispose(): void {}
}

/** Change a canvas's z-order (e.g. bring to front). */
export class ReorderCanvasCommand implements Command {
  readonly label = 'Bring canvas to front';
  constructor(
    readonly canvasId: CanvasId,
    private readonly from: number,
    private readonly to: number,
  ) {}

  private moveTo(ctx: CommandContext, index: number): Change {
    const doc = ctx.canvas(this.canvasId);
    ctx.detachCanvas(this.canvasId);
    ctx.attachCanvas(doc, index);
    return canvasChange(this.canvasId, { selectCanvas: this.canvasId });
  }

  apply(ctx: CommandContext): Change {
    return this.moveTo(ctx, this.to);
  }

  revert(ctx: CommandContext): Change {
    return this.moveTo(ctx, this.from);
  }

  dispose(): void {}
}

/**
 * Resize a canvas: new placement and new tiles for every layer. The command
 * holds whichever state is *not* in the canvas (the new one before the first
 * apply, the old one afterwards), and apply/revert simply swap the two.
 */
export class ResizeCanvasCommand implements Command {
  readonly label = 'Resize canvas';
  constructor(
    readonly canvasId: CanvasId,
    private stored: { placement: Placement; tiles: Map<LayerId, Map<TileKey, TileSlot>> },
  ) {}

  private swap(ctx: CommandContext): Change {
    const doc = ctx.canvas(this.canvasId);
    const current = doc.placement;
    Object.assign(doc, this.stored.placement);
    this.stored.placement = current;
    for (const [layerId, tiles] of this.stored.tiles) {
      const layerTiles = doc.layer(layerId).tiles;
      const previous = new Map(layerTiles);
      layerTiles.clear();
      for (const [k, s] of tiles) layerTiles.set(k, s);
      tiles.clear();
      for (const [k, s] of previous) tiles.set(k, s);
    }
    return canvasChange(this.canvasId, { layers: [...this.stored.tiles.keys()] });
  }

  apply(ctx: CommandContext): Change {
    return this.swap(ctx);
  }

  revert(ctx: CommandContext): Change {
    return this.swap(ctx);
  }

  dispose(ctx: CommandContext): void {
    const store = ctx.canvas(this.canvasId).store;
    for (const tiles of this.stored.tiles.values()) releaseAllTiles(store, tiles);
  }

  forgetEmptySlot(ctx: CommandContext, slot: TileSlot): void {
    const store = ctx.canvas(this.canvasId).store;
    for (const tiles of this.stored.tiles.values()) {
      for (const [key, s] of tiles) {
        if (s === slot) {
          tiles.delete(key);
          store.release(slot);
        }
      }
    }
  }
}
