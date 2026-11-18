import { GESTURES } from '../config';
import type { Vec2 } from '../viewport/viewport';

export type GestureThresholds = typeof GESTURES;

/** What a finished touch session turned out to be. */
export type TapResult = { fingers: 2 | 3 } | null;

interface TrackedTouch {
  start: Vec2;
  maxMove: number;
}

/**
 * Recognises multi-finger taps and single-finger touch-and-hold.
 *
 * A "session" runs from the first finger touching down until the last one
 * lifts. It is a tap if every finger stayed within `tapMaxMovementPx` and the
 * whole session took at most `tapMaxDurationMs`. It counts the most fingers
 * that were down at once (2 = undo, 3 = redo).
 *
 * Large contacts (a palm, see `palmContactPx`) spoil the session, as does
 * the pen touching down. Time is passed in, so this is pure and testable.
 */
export class TouchGestures {
  private touches = new Map<number, TrackedTouch>();
  private sessionStart = 0;
  private maxFingers = 0;
  private spoiled = false;
  private holdId: number | null = null;

  constructor(private readonly t: GestureThresholds = GESTURES) {}

  /** The finger currently doing a touch-and-hold (or an eyedropper-tool pick), if any. */
  get holdingTouch(): number | null {
    return this.holdId;
  }

  down(id: number, p: Vec2, contactSize: number, now: number): void {
    if (this.touches.size === 0) {
      this.sessionStart = now;
      this.maxFingers = 0;
      this.spoiled = false;
    }
    this.touches.set(id, { start: p, maxMove: 0 });
    this.maxFingers = Math.max(this.maxFingers, this.touches.size);
    if (contactSize > this.t.palmContactPx || this.touches.size > 3) this.spoiled = true;
  }

  move(id: number, p: Vec2): void {
    const touch = this.touches.get(id);
    if (!touch) return;
    touch.maxMove = Math.max(touch.maxMove, Math.hypot(p.x - touch.start.x, p.y - touch.start.y));
  }

  /** The pen touched down, or something else took over: no tap this session. */
  spoil(): void {
    this.spoiled = true;
  }

  /**
   * Call `holdDurationMs` after a finger touched down. Returns true if that
   * finger is now a touch-and-hold: it's the only finger, it's not a palm,
   * and it hasn't moved.
   */
  checkHold(id: number): boolean {
    const touch = this.touches.get(id);
    if (!touch || this.spoiled || this.touches.size !== 1 || this.maxFingers !== 1) return false;
    if (touch.maxMove > this.t.holdMaxMovementPx) return false;
    this.holdId = id;
    return true;
  }

  /**
   * The hold is over, but the finger stays tracked: if a second finger landed
   * (a pinch or a quick two-finger tap), the session continues as normal.
   * A hold that simply lifts is never a tap, because only one finger was down.
   */
  releaseHold(): void {
    this.holdId = null;
  }

  /** A finger lifted. Returns the tap when the session ends as one. */
  up(id: number, now: number): TapResult {
    if (!this.touches.has(id)) return null;
    if (id === this.holdId) this.holdId = null;
    if (now - this.sessionStart > this.t.tapMaxDurationMs) this.spoiled = true;
    if (this.touches.get(id)!.maxMove > this.t.tapMaxMovementPx) this.spoiled = true;
    this.touches.delete(id);
    if (this.touches.size > 0) return null;
    if (this.spoiled) return null;
    // Moves of the fingers that lifted earlier were checked as they lifted.
    return this.maxFingers === 2 || this.maxFingers === 3 ? { fingers: this.maxFingers } : null;
  }

  /** A finger was cancelled by the OS: forget it, and don't count a tap. */
  cancel(id: number): void {
    if (!this.touches.has(id)) return;
    if (id === this.holdId) this.holdId = null;
    this.spoiled = true;
    this.touches.delete(id);
  }
}
