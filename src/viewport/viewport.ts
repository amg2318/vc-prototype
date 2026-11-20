/**
 * Viewport transform: maps document coordinates (pixels of the 2048×2048
 * document) to screen coordinates (CSS pixels of the canvas element).
 *
 *   screen = translate + rotate(rotation) · (scale · doc)
 *
 * Keeping this a plain value type (not tied to the DOM or the GPU) lets later
 * phases give every canvas in the workspace its own document space while the
 * screen stays a single shared space.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface ViewTransform {
  /** Screen CSS pixels per document pixel. */
  scale: number;
  /** Rotation in radians (positive = clockwise on screen, since screen y points down). */
  rotation: number;
  /** Screen position (CSS px) of the document origin. */
  tx: number;
  ty: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.05, max: 64 };

export const IDENTITY_VIEW: ViewTransform = { scale: 1, rotation: 0, tx: 0, ty: 0 };

export function docToScreen(v: ViewTransform, p: Vec2): Vec2 {
  const c = Math.cos(v.rotation);
  const s = Math.sin(v.rotation);
  return {
    x: v.scale * (c * p.x - s * p.y) + v.tx,
    y: v.scale * (s * p.x + c * p.y) + v.ty,
  };
}

export function screenToDoc(v: ViewTransform, p: Vec2): Vec2 {
  const c = Math.cos(v.rotation);
  const s = Math.sin(v.rotation);
  const dx = p.x - v.tx;
  const dy = p.y - v.ty;
  return {
    x: (c * dx + s * dy) / v.scale,
    y: (-s * dx + c * dy) / v.scale,
  };
}

export function clampScale(scale: number, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, scale));
}

export function panBy(v: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...v, tx: v.tx + dx, ty: v.ty + dy };
}

/**
 * Returns a transform where `docPoint` appears at `screenPoint`, keeping the
 * given scale and rotation. This is the building block for zoom and pinch:
 * pick the document point under the fingers/cursor, change scale/rotation,
 * then pin that point back under the fingers/cursor.
 */
export function pinDocPointToScreen(
  scale: number,
  rotation: number,
  docPoint: Vec2,
  screenPoint: Vec2,
): ViewTransform {
  const rotatedScaled = docToScreen({ scale, rotation, tx: 0, ty: 0 }, docPoint);
  return {
    scale,
    rotation,
    tx: screenPoint.x - rotatedScaled.x,
    ty: screenPoint.y - rotatedScaled.y,
  };
}

/** Zoom by `factor` around a fixed screen point (e.g. the mouse cursor). */
export function zoomAt(
  v: ViewTransform,
  screenPoint: Vec2,
  factor: number,
  limits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
): ViewTransform {
  const anchor = screenToDoc(v, screenPoint);
  return pinDocPointToScreen(clampScale(v.scale * factor, limits), v.rotation, anchor, screenPoint);
}

/**
 * Two-finger pan / pinch / (optional) rotate.
 *
 * Given the transform when the gesture started and the start/current screen
 * positions of both fingers, returns the transform that keeps the document
 * point that was under the fingers' midpoint under their current midpoint,
 * scaled by the change in finger distance (and rotated by the change in angle).
 * Computing from the gesture start (not incrementally) avoids drift.
 */
export function twoFingerTransform(
  start: ViewTransform,
  a0: Vec2,
  b0: Vec2,
  a1: Vec2,
  b1: Vec2,
  allowRotation: boolean,
  limits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
): ViewTransform {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const factor = d0 > 1e-6 && d1 > 1e-6 ? d1 / d0 : 1;
  const scale = clampScale(start.scale * factor, limits);

  let rotation = start.rotation;
  if (allowRotation && d0 > 1e-6 && d1 > 1e-6) {
    const angle0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
    const angle1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
    rotation = start.rotation + (angle1 - angle0);
  }

  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const anchor = screenToDoc(start, mid0);
  return pinDocPointToScreen(scale, rotation, anchor, mid1);
}

/** Centre the document in the view, scaled to fit with a margin (CSS px). */
export function fitToView(
  docWidth: number,
  docHeight: number,
  viewWidth: number,
  viewHeight: number,
  margin = 24,
): ViewTransform {
  return fitRectToView({ x: 0, y: 0, width: docWidth, height: docHeight }, viewWidth, viewHeight, margin);
}

/** Centre a workspace rectangle in the view, unrotated and scaled to fit with a margin (CSS px). */
export function fitRectToView(
  rect: { x: number; y: number; width: number; height: number },
  viewWidth: number,
  viewHeight: number,
  margin = 24,
): ViewTransform {
  const availW = Math.max(1, viewWidth - 2 * margin);
  const availH = Math.max(1, viewHeight - 2 * margin);
  const scale = clampScale(Math.min(availW / Math.max(1, rect.width), availH / Math.max(1, rect.height)));
  return pinDocPointToScreen(
    scale,
    0,
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    { x: viewWidth / 2, y: viewHeight / 2 },
  );
}

/**
 * Column-major 3×3 matrix mapping document pixels to clip space
 * (x right, y up, both in [-1, 1]) for a view of the given CSS size.
 * Both WebGPU and WebGL2 use this convention for the final screen pass.
 */
export function docToClipMatrix(v: ViewTransform, viewWidth: number, viewHeight: number): Float64Array {
  const c = Math.cos(v.rotation) * v.scale;
  const s = Math.sin(v.rotation) * v.scale;
  const sx = 2 / viewWidth;
  const sy = -2 / viewHeight; // screen y points down, clip y points up
  // screen = [c -s tx; s c ty];  clip = [sx 0 -1; 0 sy 1] · screen
  // Double precision: the renderer maps far-away canvases on the CPU (see RenderCore).
  return new Float64Array([
    sx * c, sy * s, 0, // column 0
    -sx * s, sy * c, 0, // column 1
    sx * v.tx - 1, sy * v.ty + 1, 1, // column 2
  ]);
}
