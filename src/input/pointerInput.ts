import { panBy, zoomAt, type ViewTransform } from '../viewport/viewport';
import { TouchNavigator } from './gestures';
import { isEraserEvent, penSampleFromEvent, type PenSample } from './penSample';

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
}

const supportsCoalesced = typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype;
const supportsPredicted = typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype;

export const inputCapabilities = { coalescedEvents: supportsCoalesced, predictedEvents: supportsPredicted };

/**
 * Routes Pointer Events:
 *  - pen / mouse primary button → drawing (one stroke at a time)
 *  - touch → two-finger navigation, ignored entirely while the pen is down
 *  - middle mouse drag, or space + drag → pan; mouse wheel → zoom at cursor
 */
export class PointerInput {
  readonly touch = new TouchNavigator();
  private drawingPointer: number | null = null;
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

  get penDown(): boolean {
    return this.drawingPointer !== null;
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
      this.touch.down(e.pointerId, this.screenPoint(e), this.callbacks.getView(), e.timeStamp);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Pen or mouse.
    if (this.drawingPointer !== null || this.panPointer !== null) return;
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
    const restore = this.touch.rejectAllForPen();
    if (restore) this.callbacks.setView(restore);

    this.drawingPointer = e.pointerId;
    this.drawingIsEraser = eraser;
    this.canvas.setPointerCapture(e.pointerId);
    this.callbacks.strokeBegin(this.sample(e));
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (this.penDown) return;
      const view = this.touch.move(e.pointerId, this.screenPoint(e));
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
      this.touch.up(e.pointerId);
      return;
    }
    if (this.panPointer?.id === e.pointerId) {
      this.panPointer = null;
      this.canvas.style.cursor = this.spaceHeld ? 'grab' : '';
      return;
    }
    if (e.pointerId === this.drawingPointer) {
      // The pointerup sample itself is not added: it reports pressure 0,
      // which would put a tiny dab at the end of every stroke.
      this.drawingPointer = null;
      this.callbacks.strokeEnd(cancelled);
    }
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
