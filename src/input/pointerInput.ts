import { panBy, screenToDoc, zoomAt, type Vec2, type ViewTransform } from '../viewport/viewport';
import { GESTURES } from '../config';
import { TouchNavigator } from './gestures';
import { TouchGestures } from './touchGestures';
import { isEraserEvent, penSampleFromEvent, type PenSample } from './penSample';

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
  /** A touch was ignored because the pen was down (for the HUD). */
  palmRejected(): void;
  /** True while the eyedropper tool is selected: pen/mouse then sample instead of drawing. */
  eyedropperActive(): boolean;
  /** Sample the visible colour at a point (screen CSS px and canvas px). */
  eyedropper(phase: EyedropperPhase, screen: Vec2, doc: Vec2): void;
  /** A multi-finger tap on the canvas (2 = undo, 3 = redo). */
  tap(fingers: 2 | 3): void;
}

const supportsCoalesced = typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype;
const supportsPredicted = typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype;

export const inputCapabilities = { coalescedEvents: supportsCoalesced, predictedEvents: supportsPredicted };

/**
 * Routes Pointer Events:
 *  - pen / mouse primary button → drawing (one stroke at a time)
 *  - touch → two-finger navigation, ignored entirely while the pen is down;
 *    two/three-finger taps; one-finger touch-and-hold → eyedropper
 *  - middle mouse drag, or space + drag → pan; mouse wheel → zoom at cursor
 */
export class PointerInput {
  readonly touch = new TouchNavigator();
  readonly gestures = new TouchGestures();
  /** Touch positions (screen px), and the view when the first finger landed. */
  private touchPoints = new Map<number, Vec2>();
  private viewAtTouchStart: ViewTransform | null = null;
  private drawingPointer: number | null = null;
  private eyedropperPointer: number | null = null;
  private drawingIsEraser = false;
  private panPointer: { id: number; x: number; y: number } | null = null;
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
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => (this.spaceHeld = false));
    this.updateOrigin();
  }

  /** True while a pen or mouse is down for drawing or the eyedropper (touch is ignored then). */
  get penDown(): boolean {
    return this.drawingPointer !== null || this.eyedropperPointer !== null;
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
    if (e.pointerType === 'touch') {
      if (this.penDown) {
        this.callbacks.palmRejected();
        return;
      }
      // A second finger during a touch-and-hold means a pinch: cancel the pick and navigate.
      if (this.gestures.holdingTouch !== null) this.endHold('cancel');
      const p = this.screenPoint(e);
      if (this.touchPoints.size === 0) this.viewAtTouchStart = this.callbacks.getView();
      this.touchPoints.set(e.pointerId, p);
      this.gestures.down(e.pointerId, p, Math.max(e.width, e.height), e.timeStamp);
      this.touch.down(e.pointerId, p, this.callbacks.getView(), e.timeStamp);
      this.canvas.setPointerCapture(e.pointerId);
      const id = e.pointerId;
      // A finger uses the eyedropper by touch-and-hold, whatever the tool.
      window.setTimeout(() => this.startHold(id), GESTURES.holdDurationMs);
      return;
    }

    // Pen or mouse.
    if (this.drawingPointer !== null || this.panPointer !== null || this.eyedropperPointer !== null) return;
    const wantsPan = e.button === 1 || (e.button === 0 && this.spaceHeld);
    if (wantsPan) {
      this.panPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const eraser = isEraserEvent(e);
    if (e.button !== 0 && !eraser) return; // barrel/right buttons: unused in Phase 0

    // Pen wins over any touches already on the glass (likely a palm).
    this.endHold();
    this.gestures.spoil();
    const restore = this.touch.rejectAllForPen();
    if (restore) this.callbacks.setView(restore);

    if (this.callbacks.eyedropperActive() && !eraser) {
      this.eyedropperPointer = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.callEyedropper('start', e);
      return;
    }

    this.drawingPointer = e.pointerId;
    this.drawingIsEraser = eraser;
    this.canvas.setPointerCapture(e.pointerId);
    this.callbacks.strokeBegin(this.sample(e));
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (this.penDown) return;
      const p = this.screenPoint(e);
      if (this.touchPoints.has(e.pointerId)) this.touchPoints.set(e.pointerId, p);
      if (e.pointerId === this.gestures.holdingTouch) {
        this.callbacks.eyedropper('move', p, screenToDoc(this.callbacks.getView(), p));
        return;
      }
      this.gestures.move(e.pointerId, p);
      const view = this.touch.move(e.pointerId, p);
      if (view) this.callbacks.setView(view);
      return;
    }

    if (this.panPointer?.id === e.pointerId) {
      const dx = e.clientX - this.panPointer.x;
      const dy = e.clientY - this.panPointer.y;
      this.panPointer.x = e.clientX;
      this.panPointer.y = e.clientY;
      this.callbacks.setView(panBy(this.callbacks.getView(), dx, dy));
      return;
    }

    if (e.pointerId === this.eyedropperPointer) {
      this.callEyedropper('move', e);
      return;
    }
    if (e.pointerId !== this.drawingPointer) return; // e.g. pen hover
    const coalesced = supportsCoalesced ? e.getCoalescedEvents() : [];
    const raw = coalesced.length > 0 ? coalesced : [e];
    const predicted = supportsPredicted ? e.getPredictedEvents() : [];
    this.callbacks.strokeMove(
      raw.map((ev) => this.sample(ev)),
      predicted.map((ev) => this.sample(ev, true)),
    );
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
    if (e.pointerId === this.drawingPointer) {
      // The pointerup sample itself is not added: it reports pressure 0,
      // which would put a tiny dab at the end of every stroke.
      this.drawingPointer = null;
      this.callbacks.strokeEnd(cancelled);
    }
  }

  private finishTouch(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerId === this.gestures.holdingTouch) this.endHold();
    const tap = cancelled ? (this.gestures.cancel(e.pointerId), null) : this.gestures.up(e.pointerId, e.timeStamp);
    this.touch.up(e.pointerId);
    this.touchPoints.delete(e.pointerId);
    if (tap) {
      // The fingers may have nudged the view a little before lifting; undo that.
      if (this.viewAtTouchStart) this.callbacks.setView(this.viewAtTouchStart);
      this.callbacks.tap(tap.fingers);
    }
  }

  /** Called `holdDurationMs` after a finger landed. */
  private startHold(id: number): void {
    if (this.penDown || !this.gestures.checkHold(id)) return;
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

  private callEyedropper(phase: EyedropperPhase, e: PointerEvent): void {
    const screen = this.screenPoint(e);
    this.callbacks.eyedropper(phase, screen, screenToDoc(this.callbacks.getView(), screen));
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const lineHeight = 16;
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * lineHeight : e.deltaY;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; make it a bit more sensitive.
    const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(-delta * sensitivity);
    const p = { x: e.clientX - this.origin.x, y: e.clientY - this.origin.y };
    this.callbacks.setView(zoomAt(this.callbacks.getView(), p, factor));
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
