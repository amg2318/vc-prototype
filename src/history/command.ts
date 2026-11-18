import type { CanvasId, LayerId, PaintDocument } from '../document/paintDocument';
import type { TileKey, TileSlot } from '../document/tiles';

/**
 * What a command needs to find the things it changes. Phase 1 has one canvas;
 * the workspace in later phases resolves many, so commands always look their
 * canvas up by id instead of holding the document directly.
 */
export interface CommandContext {
  canvas(id: CanvasId): PaintDocument;
}

/** What changed, so the app knows what to recomposite and refresh. */
export interface Change {
  canvasId: CanvasId;
  /** Tiles whose composite may have changed. */
  tiles: TileKey[] | 'all';
  /** Layers whose pixels changed (for thumbnails). */
  layers: LayerId[];
  /** True if the layer list or a layer's properties changed (for the layers panel). */
  structure: boolean;
  /** Layer that should become active, if any. */
  select?: LayerId;
}

/**
 * One undoable step. `apply` does (and redoes) it, `revert` undoes it.
 *
 * Commands own references to the tiles they keep alive (e.g. a stroke keeps
 * the tiles from before it). `dispose` releases them when the step leaves the
 * history. `applied` says which state the command was in at that moment
 * (true when dropped from the undo stack, false when dropped from the redo
 * stack), since that decides who owns what.
 */
export interface Command {
  readonly label: string;
  readonly canvasId: CanvasId;
  apply(ctx: CommandContext): Change;
  revert(ctx: CommandContext): Change;
  dispose(ctx: CommandContext, applied: boolean): void;
  /** Absorb a following command of the same kind (e.g. one opacity slider drag = one step). */
  mergeWith?(next: Command): boolean;
  /** A tile slot turned out to be fully transparent: replace references to it with "no tile". */
  forgetEmptySlot?(ctx: CommandContext, slot: TileSlot): void;
}
