import type { OverlayRect } from '../render/renderer';
import type { Rect } from '../workspace/coords';

const OUTLINE_DEVICE_PX = 2;
const ACCENT: [number, number, number, number] = [0.04, 0.52, 1, 1]; // #0a84ff, opaque

/**
 * Four thin rectangles just outside a canvas's edges, so the outline of the
 * selected canvas never covers its pixels. `canvasPxPerDevicePx` keeps the
 * line 2 device pixels wide at any zoom.
 */
export function selectionOutline(r: Rect, canvasPxPerDevicePx: number): OverlayRect[] {
  const w = OUTLINE_DEVICE_PX * canvasPxPerDevicePx;
  const edge = (x: number, y: number, width: number, height: number): OverlayRect => ({
    rect: { x, y, width, height },
    color: ACCENT,
  });
  return [
    edge(r.x - w, r.y - w, r.width + 2 * w, w), // top
    edge(r.x - w, r.y + r.height, r.width + 2 * w, w), // bottom
    edge(r.x - w, r.y, w, r.height), // left
    edge(r.x + r.width, r.y, w, r.height), // right
  ];
}
