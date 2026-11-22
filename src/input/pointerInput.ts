import { panBy, screenToDoc, zoomAt, type Vec2, type ViewTransform } from '../viewport/viewport';
import { GESTURES } from '../config';
import { FingerDrawing, shouldCancelFingerStroke } from './fingerDrawing';
import { TouchNavigator } from './gestures';
import { TouchGestures } from './touchGestures';
import { wheelAction } from './wheel';
import { inputKind, isEraserEvent, penSampleFromEvent, type InputKind, type PenSample } from './penSample';

/** `cancel`: a second finger landed (a pinch), so the pick should be undone. */
export type EyedropperPhase = 'start' | 'move' | 'end' | 'cancel';

/** What the input layer needs from the app. */
export interface InputCallbacks {
  getView(): ViewTransform;
  setView(view: ViewTransform): void;
  strokeBegin(sample: PenSample): void;
  /** `samples` are the real (coalesced) samples for one pointermove, in order. */
  strokeMove(samples: PenSample[], predicted: PenSample[]): void;
  /** `cancelled` is true for pointercancel (e.g. the OS took over the touch). */
  strokeEnd(cancelled: boolean): void;
  /** Throw the current stroke away, leaving no trace and no undo step. */
  strokeDiscard(): void;
  /** A touch was ignored because the pen was down (for the HUD). */
  palmRejected(): void;
  /** True while the eyedropper tool is selected: pen, mouse and finger then sample instead of drawing. */
  eyedropperActive(): boolean;
  /** Sample the visible colour at a point (screen CSS px and canvas px). */
  eyedropper(phase: EyedropperPhase, screen: Vec2, doc: Vec2): void;
  /** A multi-finger tap on the canvas (2 = undo, 3 = redo). */
  tap(fingers: 2 | 3): void;
  /** True if a stroke starting at this workspace point would draw (it is over a canvas). */
  canDrawAt(p: Vec2): boolean;
  /**
   * A pen, mouse or single finger pressed on empty space (workspace point),
   * e.g. on an arrow between canvases. The press still pans if it moves.
   */
  emptySpacePress(p: Vec2): void;
}

const supportsCoalesced = typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype;
const supportsPredicted = typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype;

export const inputCapabilities = { coalescedEvents: supportsCoalesced, predictedEvents: supportsPredicted };

/** The pointer drawing the current stroke. */
interface Drawing {
  id: number;
  kind: InputKind;
  start: Vec2;
  startTime: number;
  /** Furthest distance from `start` so far (screen CSS px). */
  maxMove: number;
}

/**
 * Routes Pointer Events:
 *  - pen, mouse left button, or one finger (when finger drawing is on) →
 *    the current tool (draw, erase or eyedropper), one stroke at a time;
 *  - Alt/Option + mouse or pen → eyedropper;
 *  - a drag that starts on empty space, one finger when finger drawing is
 *    off, middle mouse drag, or space + drag → pan;
 *  - two fingers → pan and pinch-zoom; two/three-finger taps → undo/redo;
 *    a second finger right after a one-finger stroke starts cancels that
 *    stroke (it was the start of a gesture);
 *  - one finger held still → eyedropper (discarding the stroke it started);
 *  - while a pen is down, all touch is ignored (palm rejection);
 *  - wheel: trackpad scroll pans, pinch or ⌘/Ctrl + wheel zooms (see wheel.ts).
 */
export class PointerInput {
  readonly touch = new TouchNavigator();
  readonly gestures = new TouchGestures();
  readonly fingers = new FingerDrawing();
  /** Touch positions (screen px), and the view when the first finger landed. */
  private touchPoints = new Map<number, Vec2>();
  private viewAtTouchStart: ViewTransform | null = null;
  private drawing: Drawing | null = null;
  private drawingIsEraser = false;
  private eyedropperPointer: number | null = null;
  private panPointer: { id: number; x: number; y: number; touch: boolean } | null = null;
  /** The last finger's reported contact size (CSS px), for the HUD: tunes `palmContactPx`. */
  lastTouchSizePx: number | null = null;
  private spaceHeld = false;
  private origin = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: InputCallbacks,
  ) {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => (this.spaceHeld = false));
    this.updateOrigin();
  }

  /** True while a pen or mouse is down for drawing or the eyedropper (touch is ignored then). */
  get penDown(): boolean {
    return (this.drawing !== null && this.drawing.kind !== 'touch') || this.eyedropperPointer !== null;
  }

  /** Call after the canvas moves or resizes. */
  updateOrigin(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.origin = { x: rect.left, y: rect.top };
  }

  private screenPoint(e: PointerEvent): { x: number; y: number } {
    return { x: e.clientX - this.origin.x, y: e.clientY - this.origin.y };
  }

  private sample(e: PointerEvent, predicted = false): PenSample {
    return penSampleFromEvent(e, this.callbacks.getView(), this.origin, predicted, this.drawingIsEraser);
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (e.pointerType === 'touch') this.touchDown(e);
    else this.penOrMouseDown(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.touchMove(e);
      return;
    }
    if (this.panPointer?.id === e.pointerId) {
      this.pan(e);
      return;
    }
    if (e.pointerId === this.eyedropperPointer) {
      this.callEyedropper('move', e);
      return;
    }
    if (e.pointerId === this.drawing?.id) this.addSamples(e); // otherwise e.g. pen hover
  };

  private onPointerUp = (e: PointerEvent): void => this.finishPointer(e, false);
  private onPointerCancel = (e: PointerEvent): void => this.finishPointer(e, true);

  private finishPointer(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === 'touch') {
      this.finishTouch(e, cancelled);
      return;
    }
    if (this.panPointer?.id === e.pointerId) {
      this.panPointer = null;
      this.canvas.style.cursor = this.spaceHeld ? 'grab' : '';
      return;
    }
    if (e.pointerId === this.eyedropperPointer) {
      this.eyedropperPointer = null;
      this.callEyedropper('end', e);
      return;
    }
    if (e.pointerId === this.drawing?.id) this.endStroke(cancelled);
  }

  // --- pen and mouse -----------------------------------------------------------

  private penOrMouseDown(e: PointerEvent): void {
    if (e.pointerType === 'pen') this.fingers.notePen();
    // The pen wins over a finger stroke (most likely a palm that started drawing).
    if (this.drawing?.kind === 'touch') this.discardStroke();
    if (this.panPointer?.touch) this.panPointer = null;
    if (this.drawing !== null || this.panPointer !== null || this.eyedropperPointer !== null) return;

    const eraser = isEraserEvent(e);
    const pick = !eraser && e.button === 0 && (e.altKey || this.callbacks.eyedropperActive());
    const onEmptySpace =
      e.button === 0 && !pick && !this.callbacks.canDrawAt(screenToDoc(this.callbacks.getView(), this.screenPoint(e)));
    if (onEmptySpace && !this.spaceHeld) this.callbacks.emptySpacePress(screenToDoc(this.callbacks.getView(), this.screenPoint(e)));
    if (e.button === 1 || (e.button === 0 && this.spaceHeld) || onEmptySpace) {
      this.startPan(e);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0 && !eraser) return; // right and barrel buttons: unused

    // Pen wins over any touches already on the glass (likely a palm).
    this.endHold();
    this.gestures.spoil();
    const restore = this.touch.rejectAllForPen();
    if (restore) this.callbacks.setView(restore);

    if (pick) {
      this.eyedropperPointer = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.callEyedropper('start', e);
      return;
    }
    this.startStroke(e, eraser);
  }

  // --- touch -------------------------------------------------------------------

  private touchDown(e: PointerEvent): void {
    if (this.penDown) {
      this.callbacks.palmRejected();
      return;
    }
    const drawing = this.drawing;
    if (drawing) {
      // A second finger while one finger draws: a gesture starting, or a stray touch.
      if (!shouldCancelFingerStroke(e.timeStamp - drawing.startTime, drawing.maxMove)) return;
      this.discardStroke();
    }
    // A second finger during a touch-and-hold means a pinch: cancel the pick and navigate.
    if (this.gestures.holdingTouch !== null) this.endHold('cancel');
    // A second finger turns a one-finger pan into a pinch.
    if (this.panPointer?.touch) this.panPointer = null;

    this.lastTouchSizePx = Math.max(e.width, e.height);
    const p = this.screenPoint(e);
    if (this.touchPoints.size === 0) this.viewAtTouchStart = this.callbacks.getView();
    this.touchPoints.set(e.pointerId, p);
    this.gestures.down(e.pointerId, p, Math.max(e.width, e.height), e.timeStamp);
    this.touch.down(e.pointerId, p, this.callbacks.getView(), e.timeStamp);
    this.canvas.setPointerCapture(e.pointerId);
    if (this.touchPoints.size === 1) this.firstFingerDown(e, p);
  }

  /** One finger alone: eyedropper, a stroke, or a pan. */
  private firstFingerDown(e: PointerEvent, p: Vec2): void {
    const id = e.pointerId;
    if (this.callbacks.eyedropperActive()) {
      if (this.gestures.checkHold(id)) this.callbacks.eyedropper('start', p, screenToDoc(this.callbacks.getView(), p));
      return;
    }
    if (Math.max(e.width, e.height) > GESTURES.palmContactPx) {
      this.callbacks.palmRejected();
    } else {
      const at = screenToDoc(this.callbacks.getView(), p);
      const overCanvas = this.callbacks.canDrawAt(at);
      if (!overCanvas) this.callbacks.emptySpacePress(at);
      if (this.fingers.enabled && overCanvas) this.startStroke(e, false);
      else this.startPan(e);
    }
    // Holding still turns it into the eyedropper.
    window.setTimeout(() => this.startHold(id), GESTURES.holdDurationMs);
  }

  private touchMove(e: PointerEvent): void {
    if (this.penDown) return;
    const id = e.pointerId;
    const p = this.screenPoint(e);
    if (this.touchPoints.has(id)) this.touchPoints.set(id, p);
    this.gestures.move(id, p);
    if (id === this.gestures.holdingTouch) {
      this.callbacks.eyedropper('move', p, screenToDoc(this.callbacks.getView(), p));
      return;
    }
    if (id === this.drawing?.id) {
      this.addSamples(e);
      return;
    }
    if (this.panPointer?.id === id) {
      this.pan(e);
      return;
    }
    const view = this.touch.move(id, p);
    if (view) this.callbacks.setView(view);
  }

  private finishTouch(e: PointerEvent, cancelled: boolean): void {
    const id = e.pointerId;
    if (id === this.drawing?.id) this.endStroke(cancelled);
    if (id === this.panPointer?.id) this.panPointer = null;
    if (id === this.gestures.holdingTouch) this.endHold();
    const tap = cancelled ? (this.gestures.cancel(id), null) : this.gestures.up(id, e.timeStamp);
    this.touch.up(id);
    this.touchPoints.delete(id);
    if (tap) {
      // The fingers may have nudged the view a little before lifting; undo that.
      if (this.viewAtTouchStart) this.callbacks.setView(this.viewAtTouchStart);
      this.callbacks.tap(tap.fingers);
    }
  }

  /** Called `holdDurationMs` after a finger landed. */
  private startHold(id: number): void {
    if (this.penDown || !this.gestures.checkHold(id)) return;
    if (this.drawing?.id === id) this.discardStroke(); // the tiny stroke the hold started
    if (this.panPointer?.id === id) this.panPointer = null;
    const p = this.touchPoints.get(id)!;
    this.callbacks.eyedropper('start', p, screenToDoc(this.callbacks.getView(), p));
  }

  private endHold(phase: 'end' | 'cancel' = 'end'): void {
    const id = this.gestures.holdingTouch;
    if (id === null) return;
    this.gestures.releaseHold();
    const p = this.touchPoints.get(id) ?? { x: 0, y: 0 };
    this.callbacks.eyedropper(phase, p, screenToDoc(this.callbacks.getView(), p));
  }

  // --- shared ------------------------------------------------------------------

  private startStroke(e: PointerEvent, eraser: boolean): void {
    this.drawing = {
      id: e.pointerId,
      kind: inputKind(e.pointerType),
      start: { x: e.clientX, y: e.clientY },
      startTime: e.timeStamp,
      maxMove: 0,
    };
    this.drawingIsEraser = eraser;
    this.canvas.setPointerCapture(e.pointerId);
    this.callbacks.strokeBegin(this.sample(e));
  }

  private addSamples(e: PointerEvent): void {
    const drawing = this.drawing!;
    drawing.maxMove = Math.max(drawing.maxMove, Math.hypot(e.clientX - drawing.start.x, e.clientY - drawing.start.y));
    const coalesced = supportsCoalesced ? e.getCoalescedEvents() : [];
    const raw = coalesced.length > 0 ? coalesced : [e];
    const predicted = supportsPredicted ? e.getPredictedEvents() : [];
    this.callbacks.strokeMove(
      raw.map((ev) => this.sample(ev)),
      predicted.map((ev) => this.sample(ev, true)),
    );
  }

  private endStroke(cancelled: boolean): void {
    // The pointerup sample itself is not added: it reports pressure 0,
    // which would put a tiny dab at the end of every stroke.
    this.drawing = null;
    this.callbacks.strokeEnd(cancelled);
  }

  private discardStroke(): void {
    this.drawing = null;
    this.callbacks.strokeDiscard();
  }

  private startPan(e: PointerEvent): void {
    this.panPointer = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private pan(e: PointerEvent): void {
    const pan = this.panPointer!;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    pan.x = e.clientX;
    pan.y = e.clientY;
    this.callbacks.setView(panBy(this.callbacks.getView(), dx, dy));
  }

  private callEyedropper(phase: EyedropperPhase, e: PointerEvent): void {
    const screen = this.screenPoint(e);
    this.callbacks.eyedropper(phase, screen, screenToDoc(this.callbacks.getView(), screen));
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const action = wheelAction(e);
    const view = this.callbacks.getView();
    if (action.kind === 'pan') {
      this.callbacks.setView(panBy(view, action.dx, action.dy));
      return;
    }
    const p = { x: e.clientX - this.origin.x, y: e.clientY - this.origin.y };
    this.callbacks.setView(zoomAt(view, p, action.factor));
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || e.repeat || isTextInput(e.target)) return;
    e.preventDefault();
    this.spaceHeld = true;
    if (!this.panPointer) this.canvas.style.cursor = 'grab';
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Space') return;
    this.spaceHeld = false;
    if (!this.panPointer) this.canvas.style.cursor = '';
  };
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === 'text';
}
