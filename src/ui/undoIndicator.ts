import type { Rect } from '../workspace/coords';

/** How long the indicator (or the highlight of an on-screen canvas) stays up. */
export const UNDO_FEEDBACK_MS = 1500;

/**
 * Where to point at a canvas that is entirely off screen: the spot on the
 * screen's edge (inset by `margin`) on the line from the screen's centre to
 * the canvas's centre, and that line's angle (radians, 0 = right, clockwise
 * because screen y points down). Null if any part of the canvas is visible.
 */
export function edgeIndicator(
  canvas: Rect,
  viewWidth: number,
  viewHeight: number,
  margin: number,
): { x: number; y: number; angle: number } | null {
  const visible =
    canvas.x < viewWidth && canvas.y < viewHeight && canvas.x + canvas.width > 0 && canvas.y + canvas.height > 0;
  if (visible) return null;
  const cx = viewWidth / 2;
  const cy = viewHeight / 2;
  const dx = canvas.x + canvas.width / 2 - cx;
  const dy = canvas.y + canvas.height / 2 - cy;
  // Scale the direction so it just reaches the inset edge in x or in y, whichever comes first.
  const sx = dx === 0 ? Infinity : (cx - margin) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (cy - margin) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s, angle: Math.atan2(dy, dx) };
}

/**
 * A small chip at the screen edge, "↶ Canvas 3" with an arrow toward the
 * canvas an undo or redo just changed, so an off-screen change is noticed
 * without moving the camera. Tapping it goes to that canvas.
 */
export class UndoIndicator {
  readonly element = document.createElement('button');
  private readonly arrow = document.createElement('span');
  private readonly text = document.createElement('span');
  private timer = 0;
  private canvasId: string | null = null;

  constructor(goTo: (canvasId: string) => void) {
    this.element.type = 'button';
    this.element.className = 'undo-indicator';
    this.element.hidden = true;
    this.arrow.className = 'undo-indicator-arrow';
    this.arrow.textContent = '➜';
    this.element.append(this.arrow, this.text);
    this.element.addEventListener('click', () => {
      if (this.canvasId) goTo(this.canvasId);
      this.hide();
    });
  }

  show(canvasId: string, label: string, at: { x: number; y: number; angle: number }): void {
    this.canvasId = canvasId;
    this.text.textContent = label;
    this.arrow.style.transform = `rotate(${at.angle}rad)`;
    this.element.hidden = false;
    // Centre the chip on the point, then keep it on screen.
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    const x = Math.min(Math.max(at.x - w / 2, 8), window.innerWidth - w - 8);
    const y = Math.min(Math.max(at.y - h / 2, 8), window.innerHeight - h - 8);
    this.element.style.transform = `translate(${x}px, ${y}px)`;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), UNDO_FEEDBACK_MS);
  }

  hide(): void {
    this.element.hidden = true;
    this.canvasId = null;
  }
}
