import { ARROW_STYLE } from '../config';
import type { InheritedBlock } from '../document/inheritedBlock';
import type { CanvasId } from '../document/paintDocument';
import type { OverlayQuad, Rgba } from '../render/renderer';
import type { Rect } from '../workspace/coords';
import type { InheritanceGraph } from '../workspace/inheritanceGraph';
import type { Vec2 } from '../viewport/viewport';

/**
 * Arrows between canvases: where they go (workspace coordinates) and how
 * they are drawn in the overlay pass. Pure, so it is unit-tested; the same
 * lines are used to hit-test arrows.
 *
 * Arrows are straight lines from the source's edge to the inheritor's edge
 * (curves are a later phase). An inheritor whose source was deleted gets a
 * short broken stub on its left edge instead.
 */

export interface ArrowLine {
  /** Arrows are identified by their inheritor: a canvas has at most one incoming arrow. */
  inheritorId: CanvasId;
  kind: 'linked' | 'missing';
  from: Vec2;
  to: Vec2;
}

export type Emphasis = 'low' | 'medium' | 'full';

export interface ArrowCanvas {
  id: CanvasId;
  placement: Rect;
  inherited: InheritedBlock | null;
}

/** Every arrow and stub in the workspace. */
export function arrowLines(canvases: readonly ArrowCanvas[], canvasPxPerDevicePx: number): ArrowLine[] {
  const byId = new Map(canvases.map((c) => [c.id, c]));
  const gap = ARROW_STYLE.gapDevicePx * canvasPxPerDevicePx;
  const lines: ArrowLine[] = [];
  for (const c of canvases) {
    const source = c.inherited?.source;
    if (source?.kind === 'linked') {
      const from = byId.get(source.canvasId);
      if (!from) continue;
      const line = edgeToEdge(from.placement, c.placement, gap);
      if (line) lines.push({ inheritorId: c.id, kind: 'linked', ...line });
    } else if (source?.kind === 'missing') {
      const r = c.placement;
      const y = r.y + r.height / 2;
      const length = ARROW_STYLE.stubDevicePx * canvasPxPerDevicePx;
      lines.push({ inheritorId: c.id, kind: 'missing', from: { x: r.x - gap - length, y }, to: { x: r.x - gap, y } });
    }
  }
  return lines;
}

/**
 * How strongly each arrow is drawn, by the spec's rule: full for the
 * selected arrow and the arrows touching the selected canvas, medium for the
 * rest of that canvas's lineage (further up- and downstream), low otherwise.
 */
export function arrowEmphasis(
  lines: readonly ArrowLine[],
  graph: InheritanceGraph,
  selectedCanvas: CanvasId | null,
  selectedArrow: CanvasId | null,
): Map<CanvasId, Emphasis> {
  const upstream = new Set(selectedCanvas ? graph.upstream(selectedCanvas) : []);
  const downstream = new Set(selectedCanvas ? graph.downstream(selectedCanvas) : []);
  const out = new Map<CanvasId, Emphasis>();
  for (const line of lines) {
    const inheritor = line.inheritorId;
    const source = graph.sourceOf(inheritor);
    let emphasis: Emphasis = 'low';
    if (inheritor === selectedArrow || inheritor === selectedCanvas || (source !== null && source === selectedCanvas)) {
      emphasis = 'full';
    } else if (upstream.has(inheritor) || downstream.has(inheritor)) {
      emphasis = 'medium';
    }
    out.set(inheritor, emphasis);
  }
  return out;
}

/**
 * The selected canvas's lineage: every canvas it inherits from, directly or
 * through a chain (upstream), and every canvas that inherits from it
 * (downstream: its dependents).
 */
export function lineage(graph: InheritanceGraph, selected: CanvasId | null): { upstream: CanvasId[]; downstream: CanvasId[] } {
  if (selected === null) return { upstream: [], downstream: [] };
  return { upstream: graph.upstream(selected), downstream: graph.downstream(selected) };
}

/**
 * Overlay quads for the arrows: a shaft and a two-stroke head each. A
 * missing-source stub is drawn as a dashed shaft in the warning colour.
 * Widths are in device pixels, so arrows look the same at any zoom.
 */
export function arrowQuads(
  lines: readonly ArrowLine[],
  emphasis: ReadonlyMap<CanvasId, Emphasis>,
  canvasPxPerDevicePx: number,
): OverlayQuad[] {
  const s = ARROW_STYLE;
  const width = s.widthDevicePx * canvasPxPerDevicePx;
  const head = s.headDevicePx * canvasPxPerDevicePx;
  const quads: OverlayQuad[] = [];
  for (const line of lines) {
    const alpha = s.opacity[emphasis.get(line.inheritorId) ?? 'low'];
    const base = line.kind === 'missing' ? s.missingColor : s.color;
    const color: Rgba = [base[0] * alpha, base[1] * alpha, base[2] * alpha, alpha]; // premultiplied
    const length = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
    if (length === 0) continue;
    const dir = { x: (line.to.x - line.from.x) / length, y: (line.to.y - line.from.y) / length };
    if (line.kind === 'missing') {
      // Broken: three dashes.
      const dash = length / 5;
      for (let i = 0; i < 3; i++) quads.push(segment(along(line.from, dir, i * 2 * dash), dir, dash, width, color));
    } else {
      quads.push(segment(line.from, dir, Math.max(0, length - width / 2), width, color));
    }
    // Head: two strokes meeting at the tip, at ±30° from the shaft.
    for (const side of [-1, 1]) {
      const back = rotate({ x: -dir.x, y: -dir.y }, (side * Math.PI) / 6);
      const tip = along(line.to, back, width / 2);
      quads.push(segment(tip, back, head, width, color));
    }
  }
  return quads;
}

/** The arrow under `p` (workspace coordinates), within `tolerance`, nearest first; null if none. */
export function hitArrow(lines: readonly ArrowLine[], p: Vec2, tolerance: number): ArrowLine | null {
  let best: ArrowLine | null = null;
  let bestDistance = tolerance;
  for (const line of lines) {
    const d = distanceToSegment(p, line.from, line.to);
    if (d <= bestDistance) {
      best = line;
      bestDistance = d;
    }
  }
  return best;
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The part of the centre-to-centre line between two rects that lies outside
 * both, shortened by `gap` at each end; null if the rects overlap so much
 * that nothing is left.
 */
export function edgeToEdge(from: Rect, to: Rect, gap: number): { from: Vec2; to: Vec2 } | null {
  const a = centre(from);
  const b = centre(to);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return null;
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const start = exitDistance(from, a, dir) + gap;
  const end = length - exitDistance(to, b, { x: -dir.x, y: -dir.y }) - gap;
  if (end <= start) return null;
  return { from: along(a, dir, start), to: along(a, dir, end) };
}

/** How far a ray from `p` (inside `r`) travels in direction `dir` before leaving `r`. */
function exitDistance(r: Rect, p: Vec2, dir: Vec2): number {
  const tx = dir.x > 0 ? (r.x + r.width - p.x) / dir.x : dir.x < 0 ? (r.x - p.x) / dir.x : Infinity;
  const ty = dir.y > 0 ? (r.y + r.height - p.y) / dir.y : dir.y < 0 ? (r.y - p.y) / dir.y : Infinity;
  return Math.min(tx, ty);
}

/** A straight stroke `length` long from `start` in direction `dir`, `width` wide. */
function segment(start: Vec2, dir: Vec2, length: number, width: number, color: Rgba): OverlayQuad {
  const normal = { x: -dir.y, y: dir.x };
  return {
    origin: { x: start.x - (normal.x * width) / 2, y: start.y - (normal.y * width) / 2 },
    xAxis: { x: dir.x * length, y: dir.y * length },
    yAxis: { x: normal.x * width, y: normal.y * width },
    color,
  };
}

function centre(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function along(p: Vec2, dir: Vec2, distance: number): Vec2 {
  return { x: p.x + dir.x * distance, y: p.y + dir.y * distance };
}

function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
