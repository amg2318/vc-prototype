import { croppedSize, cropRect, type BlockCrop, type BlockPlacement, type InheritedBlock, type Size } from './inheritedBlock';

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

// --- cropping on the canvas -------------------------------------------------------

/**
 * A crop handle: which sides of the block it moves, in the block's own axes
 * (u: -1 left, 1 right; v: -1 top, 1 bottom; 0 = that axis stays). Corners
 * move two sides, edge handles one.
 */
export interface CropHandle {
  u: -1 | 0 | 1;
  v: -1 | 0 | 1;
}

export interface CropDrag {
  handle: CropHandle;
  /** Pointer where the drag started. */
  start: Point;
  /** The block and its source's size when the drag started. */
  block: InheritedBlock;
  sourceSize: Size;
}

/** Narrowest a crop can get (inheritor pixels), so its handles stay apart. */
export const MIN_CROP_PX = 8;

/**
 * The crop and block centre for the pointer at `p` during `drag`. The
 * dragged sides follow the pointer (within the source); the content does
 * not move on the canvas, whatever the rotation, scale and flips.
 */
export function dragCrop(drag: CropDrag, p: Point): { crop: BlockCrop | undefined; centre: Point } {
  const { block, sourceSize, handle } = drag;
  const frame = blockFrame(block, sourceSize);
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  const du = dx * cos + dy * sin;
  const dv = -dx * sin + dy * cos;

  // Where the source's edges are, in the block's axes: the crop can grow up to them.
  const r = cropRect(block.crop, sourceSize);
  const s = block.placement.scale;
  const fx = block.placement.flipX ? -1 : 1;
  const fy = block.placement.flipY ? -1 : 1;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const uLimits = sorted(fx * s * -cx, fx * s * (sourceSize.width - cx));
  const vLimits = sorted(fy * s * -cy, fy * s * (sourceSize.height - cy));

  const [left, right] = moveSides(-frame.halfWidth, frame.halfWidth, handle.u, du, uLimits);
  const [top, bottom] = moveSides(-frame.halfHeight, frame.halfHeight, handle.v, dv, vLimits);

  // Back to source pixels: u = fx * s * (x - cx), so x = cx + fx * u / s.
  const [x0, x1] = sorted(cx + (fx * left) / s, cx + (fx * right) / s);
  const [y0, y1] = sorted(cy + (fy * top) / s, cy + (fy * bottom) / s);
  const crop = {
    x: clamp01(x0 / sourceSize.width),
    y: clamp01(y0 / sourceSize.height),
    width: clamp01((x1 - x0) / sourceSize.width),
    height: clamp01((y1 - y0) / sourceSize.height),
  };
  const whole = crop.x < 1e-6 && crop.y < 1e-6 && crop.width > 1 - 1e-6 && crop.height > 1 - 1e-6;
  return { crop: whole ? undefined : crop, centre: framePoint(frame, (left + right) / 2, (top + bottom) / 2) };
}

/** Move the low (side -1) or high (side 1) end of [lo, hi] by `delta`, within `limits`, keeping it at least MIN_CROP_PX wide. */
function moveSides(lo: number, hi: number, side: -1 | 0 | 1, delta: number, limits: [number, number]): [number, number] {
  const min = Math.min(MIN_CROP_PX, hi - lo);
  if (side === -1) return [Math.min(Math.max(lo + delta, limits[0]), hi - min), hi];
  if (side === 1) return [lo, Math.max(Math.min(hi + delta, limits[1]), lo + min)];
  return [lo, hi];
}

function sorted(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
