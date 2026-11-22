import { croppedSize, type BlockPlacement, type InheritedBlock, type Size } from './inheritedBlock';

/**
 * The maths of block-transform mode: the block's frame on the inheritor and
 * how dragging a handle changes the placement. Everything is in inheritor
 * canvas pixels. Pure, so it is unit-tested.
 */

export interface Point {
  x: number;
  y: number;
}

/** The block's outline: a rotated rectangle (flips don't change it). */
export interface BlockFrame {
  centre: Point;
  halfWidth: number;
  halfHeight: number;
  rotation: number;
}

export function blockFrame(block: InheritedBlock, sourceSize: Size): BlockFrame {
  const size = croppedSize(block.crop, sourceSize);
  const p = block.placement;
  return { centre: { x: p.x, y: p.y }, halfWidth: (size.width * p.scale) / 2, halfHeight: (size.height * p.scale) / 2, rotation: p.rotation };
}

/** A point given in the frame's own axes (u right, v down, from the centre). */
export function framePoint(frame: BlockFrame, u: number, v: number): Point {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return { x: frame.centre.x + u * cos - v * sin, y: frame.centre.y + u * sin + v * cos };
}

/** Corners in order: top left, top right, bottom right, bottom left (before rotation). */
export function frameCorners(frame: BlockFrame): Point[] {
  const { halfWidth: w, halfHeight: h } = frame;
  return [framePoint(frame, -w, -h), framePoint(frame, w, -h), framePoint(frame, w, h), framePoint(frame, -w, h)];
}

/** Where the rotate handle sits: `distance` above the middle of the top edge. */
export function rotateHandle(frame: BlockFrame, distance: number): Point {
  return framePoint(frame, 0, -frame.halfHeight - distance);
}

/**
 * A drag on one of the handles:
 *  - 'move': the block body; the centre follows the pointer;
 *  - 'scale': a corner; the size changes about the centre, so the corner
 *    follows the pointer's distance from the centre (aspect is kept);
 *  - 'rotate': the rotate handle; the block turns with the pointer's angle
 *    around the centre, snapping to multiples of 15° when close.
 */
export interface TransformDrag {
  kind: 'move' | 'scale' | 'rotate';
  /** Pointer where the drag started. */
  start: Point;
  /** Placement when the drag started. */
  placement: BlockPlacement;
}

/** Below this, the block would be too small to grab again. */
export const MIN_SCALE = 0.01;
const SNAP_STEP = Math.PI / 12; // 15°
const SNAP_WITHIN = (2 * Math.PI) / 180; // 2°

/** The placement changes for the pointer at `p` during `drag`. */
export function dragPlacement(drag: TransformDrag, p: Point): Partial<BlockPlacement> {
  const start = drag.placement;
  const centre = { x: start.x, y: start.y };
  switch (drag.kind) {
    case 'move':
      return { x: start.x + p.x - drag.start.x, y: start.y + p.y - drag.start.y };
    case 'scale': {
      const before = Math.hypot(drag.start.x - centre.x, drag.start.y - centre.y);
      const now = Math.hypot(p.x - centre.x, p.y - centre.y);
      if (before === 0) return {};
      return { scale: Math.max(MIN_SCALE, (start.scale * now) / before) };
    }
    case 'rotate': {
      const before = Math.atan2(drag.start.y - centre.y, drag.start.x - centre.x);
      const now = Math.atan2(p.y - centre.y, p.x - centre.x);
      return { rotation: snapAngle(normalizeAngle(start.rotation + now - before)) };
    }
  }
}

/** Angle in (-π, π]. */
export function normalizeAngle(a: number): number {
  const turns = Math.round(a / (2 * Math.PI));
  const r = a - turns * 2 * Math.PI;
  return r <= -Math.PI ? r + 2 * Math.PI : r;
}

/** Snap to the nearest multiple of 15° if within 2° of it. */
export function snapAngle(a: number): number {
  const nearest = Math.round(a / SNAP_STEP) * SNAP_STEP;
  return Math.abs(a - nearest) <= SNAP_WITHIN ? nearest : a;
}
