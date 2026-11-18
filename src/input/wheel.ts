/**
 * What a wheel event means, Figma-style:
 *  - two-finger trackpad scroll, or a mouse wheel → pan
 *    (Shift + wheel pans sideways on mice that only scroll vertically);
 *  - trackpad pinch (the browser sends it as Ctrl + wheel) or ⌘/Ctrl + wheel
 *    → zoom at the cursor.
 */

export type WheelAction = { kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; factor: number };

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const LINE_PX = 16;
const PAGE_PX = 800;
/** Zoom per pixel of wheel delta: a pinch sends a few pixels per event, so this keeps it smooth. */
const ZOOM_PER_PX = 0.01;
/** A mouse wheel notch sends ~100 px; cap each event so ⌘ + wheel zooms in steps of at most ~1.65×. */
const MAX_ZOOM_DELTA_PX = 50;

export function wheelAction(e: WheelInput): WheelAction {
  const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
  let dx = e.deltaX * scale;
  let dy = e.deltaY * scale;
  if (e.ctrlKey || e.metaKey) {
    const delta = Math.max(-MAX_ZOOM_DELTA_PX, Math.min(MAX_ZOOM_DELTA_PX, dy));
    return { kind: 'zoom', factor: Math.exp(-delta * ZOOM_PER_PX) };
  }
  if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
  // Scrolling down moves the content up, like a scrolled page.
  return { kind: 'pan', dx: -dx, dy: -dy };
}
