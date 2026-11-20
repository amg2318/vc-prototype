import { TILE_SIZE } from '../config';
import type { TileKey } from '../document/tiles';
import { tileKey } from '../document/tiles';
import { screenToDoc, type Vec2, type ViewTransform } from '../viewport/viewport';

/**
 * The three coordinate spaces:
 *
 *  - workspace: one unit = one canvas pixel at 100% zoom. The camera
 *    (`ViewTransform`) maps workspace → screen CSS pixels.
 *  - canvas: pixels of one canvas, origin at its top-left corner.
 *    canvas = workspace − canvas position.
 *  - tile: canvas pixels ÷ TILE_SIZE, so tile (tx, ty) covers canvas pixels
 *    [tx·TILE_SIZE, (tx+1)·TILE_SIZE).
 *
 * Canvases are placed at whole-pixel positions, so canvas pixels and
 * workspace pixels line up exactly.
 */

/** An axis-aligned rectangle; right/bottom edges are exclusive. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a canvas sits in the workspace, and its size. */
export interface Placement extends Rect {}

export function workspaceToCanvas(canvas: Placement, p: Vec2): Vec2 {
  return { x: p.x - canvas.x, y: p.y - canvas.y };
}

export function canvasToWorkspace(canvas: Placement, p: Vec2): Vec2 {
  return { x: p.x + canvas.x, y: p.y + canvas.y };
}

/** The tile containing a canvas point, or null outside the canvas. */
export function canvasPointToTile(canvas: Placement, p: Vec2): { tx: number; ty: number } | null {
  if (!containsPoint({ x: 0, y: 0, width: canvas.width, height: canvas.height }, p)) return null;
  return { tx: Math.floor(p.x / TILE_SIZE), ty: Math.floor(p.y / TILE_SIZE) };
}

/** Tile grid size of a canvas (the last row/column may be partly outside the canvas). */
export function tileGridSize(canvas: { width: number; height: number }): { cols: number; rows: number } {
  return { cols: Math.ceil(canvas.width / TILE_SIZE), rows: Math.ceil(canvas.height / TILE_SIZE) };
}

/** Keys of the canvas tiles that overlap `rect` (in canvas pixels), clipped to the canvas. */
export function canvasTilesInRect(canvas: { width: number; height: number }, rect: Rect): TileKey[] {
  const clipped = intersect(rect, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  if (!clipped) return [];
  const x0 = Math.floor(clipped.x / TILE_SIZE);
  const y0 = Math.floor(clipped.y / TILE_SIZE);
  const x1 = Math.ceil((clipped.x + clipped.width) / TILE_SIZE);
  const y1 = Math.ceil((clipped.y + clipped.height) / TILE_SIZE);
  const keys: TileKey[] = [];
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) keys.push(tileKey(tx, ty));
  return keys;
}

export function containsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The overlap of two rectangles, or null if they don't overlap. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function union(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The part of the workspace the screen shows: the bounding box of the four
 * screen corners mapped into workspace space (a rotated view shows a rotated
 * rectangle, so the box is a little generous, which is fine for culling).
 */
export function visibleWorkspaceRect(view: ViewTransform, cssWidth: number, cssHeight: number): Rect {
  const corners = [
    { x: 0, y: 0 },
    { x: cssWidth, y: 0 },
    { x: 0, y: cssHeight },
    { x: cssWidth, y: cssHeight },
  ].map((p) => screenToDoc(view, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Culling: the items whose placement intersects `visible`, keeping their order. */
export function cullToRect<T extends { placement: Placement }>(items: readonly T[], visible: Rect): T[] {
  return items.filter((item) => intersect(item.placement, visible) !== null);
}

/** The topmost item (last in z-order) containing a workspace point. */
export function hitTest<T extends { placement: Placement }>(itemsBackToFront: readonly T[], p: Vec2): T | null {
  for (let i = itemsBackToFront.length - 1; i >= 0; i--) {
    if (containsPoint(itemsBackToFront[i]!.placement, p)) return itemsBackToFront[i]!;
  }
  return null;
}
