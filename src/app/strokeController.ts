import type { BrushSettings } from '../brush/brushSettings';
import type { Dab } from '../brush/dabs';
import { StrokeEngine } from '../brush/strokeEngine';
import type { Editor, StrokeMode } from '../document/editor';
import type { CanvasId, LayerId } from '../document/paintDocument';
import { DirtyTiles } from '../document/tiles';
import type { PenSample } from '../input/penSample';
import type { Renderer, StrokeStyle } from '../render/renderer';
import type { ToolState } from '../tools/tools';

export interface ActiveStroke {
  canvasId: CanvasId;
  layerId: LayerId;
  style: StrokeStyle;
}

/** Finds the canvas a stroke starting at a workspace point draws on (null: none, the stroke does nothing). */
export type StrokeTarget = (p: { x: number; y: number }) => Editor | null;

export interface StrokeEvents {
  /** The live stroke started or ended (the composite state must be rebuilt). */
  liveStrokeChanged(stroke: ActiveStroke | null): void;
  /** Dabs were queued for the GPU (for metrics). */
  dabsQueued(real: number, predicted: number): void;
  /** The stroke could not be kept because the tile pool is full. */
  poolFull(): void;
  requestFrame(): void;
}

/**
 * One brush or eraser stroke from pen-down to pen-up, on the canvas where it
 * started (samples arrive in workspace coordinates and are converted to that
 * canvas's pixels; the merge clips the stroke to the canvas):
 *
 *  - while drawing, dabs go into the renderer's stroke mask and the
 *    compositor shows them on the active layer (nothing is written to tiles);
 *  - on pen-up, the editor allocates new tiles for every tile the stroke
 *    touched and records the undo step, and the renderer merges the mask into
 *    those tiles;
 *  - after an eraser stroke, the GPU checks whether any resulting tile is now
 *    fully transparent so it can be freed.
 */
export class StrokeController {
  private readonly engine: StrokeEngine;
  private readonly dirty = new DirtyTiles();
  private active: ActiveStroke | null = null;
  private editor: Editor | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly tools: ToolState,
    private readonly events: StrokeEvents,
    private readonly targetAt: StrokeTarget,
  ) {
    this.engine = new StrokeEngine(tools.brush);
  }

  get stroke(): ActiveStroke | null {
    return this.active;
  }

  begin(workspaceSample: PenSample): void {
    const editor = this.targetAt(workspaceSample);
    if (!editor) return;
    this.editor = editor;
    const sample = this.toCanvas(workspaceSample);
    // The eraser end of a pen erases for this stroke, whatever tool is selected.
    const mode: StrokeMode = sample.isEraser || this.tools.current === 'eraser' ? 'erase' : 'paint';
    const settings: BrushSettings = mode === 'erase' ? this.tools.eraser : this.tools.brush;
    this.active = {
      canvasId: editor.doc.id,
      layerId: editor.activeLayerId,
      style: { color: [...settings.color], opacity: settings.opacity, mode },
    };
    this.dirty.clear();
    this.renderer.beginStroke(editor.doc.id);
    this.queueDabs(this.engine.begin(sample, settings), []);
    this.events.liveStrokeChanged(this.active);
  }

  move(samples: readonly PenSample[], predicted: readonly PenSample[]): void {
    if (!this.active) return;
    this.queueDabs(this.engine.add(samples.map((s) => this.toCanvas(s))), this.engine.predict(predicted.map((s) => this.toCanvas(s))));
  }

  end(): void {
    const stroke = this.active;
    const editor = this.editor;
    if (!stroke || !editor) return;
    this.queueDabs(this.engine.end(), []);
    this.active = null;
    this.editor = null;
    this.events.liveStrokeChanged(null);
    if (!editor.workspace.hasCanvas(stroke.canvasId)) return; // deleted mid-stroke

    // Committing updates the document (and, through the editor's change event,
    // the composite state) before the merge runs on the GPU in the next frame.
    const jobs = editor.commitStroke(stroke.layerId, this.dirty.keys, stroke.style.mode);
    if (jobs === null) {
      this.renderer.invalidateTiles(stroke.canvasId, [...this.dirty.keys]); // drop the preview
      this.events.poolFull();
    } else {
      this.renderer.mergeStroke(stroke.canvasId, jobs, stroke.style);
      if (stroke.style.mode === 'paint') this.tools.rememberColor(stroke.style.color);
      if (stroke.style.mode === 'erase' && jobs.length > 0) this.checkForEmptyTiles(editor, jobs.map((j) => j.dst));
    }
    this.events.requestFrame();
  }

  /**
   * Throw the stroke away (a finger stroke that turned out to be the start
   * of a gesture or a touch-and-hold): nothing is committed or undoable, and
   * the canvas recomposites without it.
   */
  discard(): void {
    const stroke = this.active;
    if (!stroke) return;
    this.engine.end();
    this.active = null;
    this.editor = null;
    this.renderer.setPredictedDabs([]);
    this.events.liveStrokeChanged(null);
    this.renderer.invalidateTiles(stroke.canvasId, [...this.dirty.keys]);
    this.events.requestFrame();
  }

  private queueDabs(real: Dab[], predicted: Dab[]): void {
    this.dirty.addDabs(real);
    this.renderer.addStrokeDabs(real);
    this.renderer.setPredictedDabs(predicted);
    this.events.dabsQueued(real.length, predicted.length);
    this.events.requestFrame();
  }

  private toCanvas(s: PenSample): PenSample {
    const doc = this.editor!.doc;
    return { ...s, x: s.x - doc.x, y: s.y - doc.y };
  }

  private checkForEmptyTiles(editor: Editor, slots: number[]): void {
    const store = editor.store;
    const generations = slots.map((s) => store.generation(s));
    void this.renderer.findEmptyTiles(slots).then((empty) => {
      const found = slots.flatMap((slot, i) => (empty[i] ? [{ slot, generation: generations[i]! }] : []));
      if (found.length > 0) editor.forgetEmptyTiles(found);
    });
  }
}
