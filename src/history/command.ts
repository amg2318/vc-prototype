import type { CanvasId, LayerId, PaintDocument } from '../document/paintDocument';
import type { TileKey, TileSlot } from '../document/tiles';

/**
 * What a command needs to find and change things. Commands always look their
 * canvas up by id instead of holding the document directly. The workspace
 * provides this.
 */
export interface CommandContext {
  /** A canvas by id, including deleted canvases that undo can bring back. */
  canvas(id: CanvasId): PaintDocument;
  /** Put a canvas into the workspace at z-index `index`. */
  attachCanvas(doc: PaintDocument, index: number): void;
  /** Take a canvas out of the workspace (it stays findable); returns its z-index. */
  detachCanvas(id: CanvasId): number;
  /** A deleted canvas will never come back: stop tracking it. */
  forgetCanvas(id: CanvasId): void;
  /** Z-index of a canvas in the workspace (0 = back). */
  canvasIndex(id: CanvasId): number;
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
  /** True if canvases were added, removed, moved, resized, renamed or reordered. */
  workspace?: boolean;
  /** Canvas that should become active, if any. */
  selectCanvas?: CanvasId;
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
