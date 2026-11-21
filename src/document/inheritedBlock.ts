import { intersect, type Rect } from '../workspace/coords';
import type { CanvasId } from './paintDocument';

/**
 * A canvas's inherited block: a live, read-only image of another canvas's
 * full visible composite, drawn below the canvas's own layers.
 *
 * This module is pure: the block's states, its placement maths and the
 * rectangle transforms that update propagation uses. Nothing here touches
 * the GPU or the workspace.
 *
 * Placement is in the inheritor's canvas pixels:
 *  - (x, y) is where the centre of the (cropped) source lands;
 *  - `scale` is inheritor pixels per source pixel;
 *  - `rotation` is in radians, clockwise on screen (y points down), around the centre;
 *  - flips mirror the source before it is scaled and rotated.
 */

export type BlockSourceState =
  | { kind: 'linked'; canvasId: CanvasId }
  /** The arrow was deleted: the slot keeps its settings and draws nothing. */
  | { kind: 'empty' }
  /** The source canvas was deleted: shown on the arrow stub and the layers panel only. */
  | { kind: 'missing'; lastCanvasId: CanvasId };

export interface BlockPlacement {
  mode: 'fit' | 'custom';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/** Part of the source to show, in normalized source coordinates (0–1). */
export interface BlockCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Effect = { kind: 'grayscale' } | { kind: 'invert' } | { kind: 'posterize'; levels: number };

/** Screen and overlay are offered on blocks only (layers have normal and multiply). */
export type BlockBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export interface Size {
  width: number;
  height: number;
}

export interface InheritedBlock {
  source: BlockSourceState;
  placement: BlockPlacement;
  /** Absent = the whole source. */
  crop?: BlockCrop;
  /** Applied in order, at render time. */
  effects: Effect[];
  opacity: number;
  blendMode: BlockBlendMode;
  visible: boolean;
  /**
   * Size of the last source this block was linked to. A custom placement keeps
   * its displayed width when the block is relinked, and an empty or missing
   * block has no source to measure.
   */
  lastSourceSize: Size;
}

/** A 2D affine map: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const FULL_CROP: BlockCrop = { x: 0, y: 0, width: 1, height: 1 };

// --- creating and changing state -----------------------------------------------

/** A new block linked to `sourceId`, fitted inside the inheritor. */
export function createBlock(sourceId: CanvasId, sourceSize: Size, inheritorSize: Size): InheritedBlock {
  return {
    source: { kind: 'linked', canvasId: sourceId },
    placement: fitPlacement(undefined, sourceSize, inheritorSize),
    effects: [],
    opacity: 1,
    blendMode: 'normal',
    visible: true,
    lastSourceSize: { ...sourceSize },
  };
}

/** The arrow was deleted: keep every setting, show nothing. */
export function emptyBlock(block: InheritedBlock): InheritedBlock {
  return { ...block, source: { kind: 'empty' } };
}

/** The source canvas was deleted. Only a linked block changes. */
export function markSourceMissing(block: InheritedBlock): InheritedBlock {
  if (block.source.kind !== 'linked') return block;
  return { ...block, source: { kind: 'missing', lastCanvasId: block.source.canvasId } };
}

/**
 * Link the block to a (new) source: create-on-empty, relink and retarget all
 * use this. Effects, opacity, blend mode, visibility and crop are kept. A
 * fitted block is refitted to the new source; a custom one keeps its centre,
 * rotation, flips and displayed width (the height follows the new source's
 * aspect ratio).
 */
export function linkBlock(block: InheritedBlock, sourceId: CanvasId, sourceSize: Size, inheritorSize: Size): InheritedBlock {
  const p = block.placement;
  let placement: BlockPlacement;
  if (p.mode === 'fit') {
    placement = fitPlacement(block.crop, sourceSize, inheritorSize);
  } else {
    const oldWidth = croppedSize(block.crop, block.lastSourceSize).width;
    const newWidth = croppedSize(block.crop, sourceSize).width;
    placement = { ...p, scale: (p.scale * oldWidth) / newWidth };
  }
  return { ...block, source: { kind: 'linked', canvasId: sourceId }, placement, lastSourceSize: { ...sourceSize } };
}

/** "Refit": back to a centred fit, dropping the custom position, size, rotation and flips. */
export function refitBlock(block: InheritedBlock, sourceSize: Size, inheritorSize: Size): InheritedBlock {
  return { ...block, placement: fitPlacement(block.crop, sourceSize, inheritorSize) };
}

/** The source's id if the block is linked. */
export function linkedSource(block: InheritedBlock | null): CanvasId | null {
  return block?.source.kind === 'linked' ? block.source.canvasId : null;
}

// --- placement maths -------------------------------------------------------------

/** Source pixels shown by the crop. */
export function croppedSize(crop: BlockCrop | undefined, sourceSize: Size): Size {
  const c = crop ?? FULL_CROP;
  return { width: c.width * sourceSize.width, height: c.height * sourceSize.height };
}

/** The crop as a rectangle in source pixels. */
export function cropRect(crop: BlockCrop | undefined, sourceSize: Size): Rect {
  const c = crop ?? FULL_CROP;
  return { x: c.x * sourceSize.width, y: c.y * sourceSize.height, width: c.width * sourceSize.width, height: c.height * sourceSize.height };
}

/** Centred, aspect preserved, as large as fits inside the inheritor. */
export function fitPlacement(crop: BlockCrop | undefined, sourceSize: Size, inheritorSize: Size): BlockPlacement {
  const { width, height } = croppedSize(crop, sourceSize);
  return {
    mode: 'fit',
    x: inheritorSize.width / 2,
    y: inheritorSize.height / 2,
    scale: Math.min(inheritorSize.width / width, inheritorSize.height / height),
    rotation: 0,
    flipX: false,
    flipY: false,
  };
}

/** Source canvas pixels → inheritor canvas pixels. */
export function sourceToInheritor(block: InheritedBlock, sourceSize: Size): Affine {
  const p = block.placement;
  const crop = cropRect(block.crop, sourceSize);
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  const sx = p.scale * (p.flipX ? -1 : 1);
  const sy = p.scale * (p.flipY ? -1 : 1);
  const cos = Math.cos(p.rotation);
  const sin = Math.sin(p.rotation);
  // Translate the crop centre to the origin, flip and scale, rotate, then move to (x, y).
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return { a, b, c, d, e: p.x - (a * cx + c * cy), f: p.y - (b * cx + d * cy) };
}

export function applyAffine(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function invertAffine(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** Bounding box of a rectangle after an affine map, rounded out to whole pixels. */
export function transformRect(m: Affine, r: Rect): Rect {
  const corners = [
    applyAffine(m, r.x, r.y),
    applyAffine(m, r.x + r.width, r.y),
    applyAffine(m, r.x, r.y + r.height),
    applyAffine(m, r.x + r.width, r.y + r.height),
  ];
  // The tolerance stops rounding noise (cos(π/2) is not exactly 0) from adding a pixel.
  const down = (v: number): number => Math.floor(v + 1e-9);
  const up = (v: number): number => Math.ceil(v - 1e-9);
  const x0 = down(Math.min(...corners.map((p) => p.x)));
  const y0 = down(Math.min(...corners.map((p) => p.y)));
  const x1 = up(Math.max(...corners.map((p) => p.x)));
  const y1 = up(Math.max(...corners.map((p) => p.y)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The part of the inheritor that changes when `dirty` (source canvas pixels)
 * changes in the source, or null if none of it shows. Bilinear sampling reads
 * one source pixel around each sample point, so the dirty area grows by one
 * source pixel before it is mapped.
 */
export function inheritorDirtyRect(block: InheritedBlock, sourceSize: Size, inheritorSize: Size, dirty: Rect): Rect | null {
  const grown = { x: dirty.x - 1, y: dirty.y - 1, width: dirty.width + 2, height: dirty.height + 2 };
  const shown = intersect(grown, cropRect(block.crop, sourceSize));
  if (!shown) return null;
  const mapped = transformRect(sourceToInheritor(block, sourceSize), shown);
  return intersect(mapped, { x: 0, y: 0, width: inheritorSize.width, height: inheritorSize.height });
}

/** The block's outline in the inheritor (four corners, in canvas pixels), e.g. for transform handles. */
export function blockCorners(block: InheritedBlock, sourceSize: Size): { x: number; y: number }[] {
  const m = sourceToInheritor(block, sourceSize);
  const r = cropRect(block.crop, sourceSize);
  return [
    applyAffine(m, r.x, r.y),
    applyAffine(m, r.x + r.width, r.y),
    applyAffine(m, r.x + r.width, r.y + r.height),
    applyAffine(m, r.x, r.y + r.height),
  ];
}
