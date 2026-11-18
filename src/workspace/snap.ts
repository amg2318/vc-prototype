import type { Rect } from './coords';

/**
 * Snapping for a canvas being dragged. Each axis snaps independently, to the
 * nearest candidate within `threshold` (workspace px):
 *  - edges of other canvases (left to left, left to right, right to left,
 *    right to right; the same for top and bottom), so canvases line up or sit
 *    side by side;
 *  - otherwise, if `grid` is set, the moving canvas's top-left to the grid.
 * Positions stay whole pixels.
 */
export function snapPosition(
  moving: Rect,
  others: readonly Rect[],
  threshold: number,
  grid: number | null,
): { x: number; y: number } {
  return {
    x: snapAxis(moving.x, moving.width, others.map((o) => [o.x, o.x + o.width] as const), threshold, grid),
    y: snapAxis(moving.y, moving.height, others.map((o) => [o.y, o.y + o.height] as const), threshold, grid),
  };
}

function snapAxis(
  start: number,
  size: number,
  edges: readonly (readonly [number, number])[],
  threshold: number,
  grid: number | null,
): number {
  let best: number | null = null;
  let bestDistance = threshold;
  const consider = (target: number): void => {
    const distance = Math.abs(target - start);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  };
  for (const [lo, hi] of edges) {
    for (const edge of [lo, hi]) {
      consider(edge); // our start edge on theirs
      consider(edge - size); // our end edge on theirs
    }
  }
  if (best === null && grid) consider(Math.round(start / grid) * grid);
  return Math.round(best ?? start);
}
