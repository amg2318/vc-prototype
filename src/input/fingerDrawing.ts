import { GESTURES } from '../config';

/**
 * Whether one finger draws.
 *  - 'on' / 'off': as set.
 *  - 'auto' (default): on until a pen is used in this session, then off, so a
 *    palm resting while drawing with a Pencil never draws. When off, one
 *    finger pans instead.
 */
export type FingerDrawingSetting = 'auto' | 'on' | 'off';

export class FingerDrawing {
  private penSeen = false;
  private listeners: (() => void)[] = [];

  constructor(private current: FingerDrawingSetting = 'auto') {}

  get setting(): FingerDrawingSetting {
    return this.current;
  }

  set setting(value: FingerDrawingSetting) {
    if (value === this.current) return;
    this.current = value;
    this.changed();
  }

  get enabled(): boolean {
    return this.current === 'on' || (this.current === 'auto' && !this.penSeen);
  }

  /** A pen touched down. In 'auto' this turns finger drawing off for the session. */
  notePen(): void {
    if (this.penSeen) return;
    this.penSeen = true;
    if (this.current === 'auto') this.changed();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * A second finger landed while a one-finger stroke was in progress. If the
 * stroke has only just started (short and barely moved), the user was most
 * likely starting a pinch or a two-finger tap: cancel the stroke and treat
 * the touches as a gesture. Otherwise keep drawing and ignore the new finger.
 */
export function shouldCancelFingerStroke(
  elapsedMs: number,
  movedPx: number,
  t: Pick<typeof GESTURES, 'strokeCancelMs' | 'strokeCancelMovementPx'> = GESTURES,
): boolean {
  return elapsedMs <= t.strokeCancelMs && movedPx <= t.strokeCancelMovementPx;
}
