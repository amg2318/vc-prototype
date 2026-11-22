import type { StrokeController } from '../app/strokeController';
import type { Effect } from '../document/inheritedBlock';
import type { CanvasId } from '../document/paintDocument';
import type { PenSample } from '../input/penSample';
import type { ViewTransform } from '../viewport/viewport';
import { union, type Rect } from '../workspace/coords';
import type { Workspace } from '../workspace/workspace';
import type { Metrics, Stats } from './metrics';

/**
 * Phase 3 stress tests (part of the `?stress` panel):
 *  - a chain: a root and N canvases, each inheriting the one before
 *    (depth 1–10);
 *  - a fan-out: a root and M canvases all inheriting it (1–20);
 * each inheritor with its own mix of placement, effects, opacity and blend
 * mode. All of them are kept on screen, then scripted strokes are drawn on
 * the root, spread over several frames each like real input, so the
 * inheritors update *during* the stroke.
 *
 * Each run resets the stats first and appends a summary to
 * `metrics.stressRuns`: source change → caught-up time per chain depth,
 * frame times, and peak GPU memory. The JSON export includes every run.
 */

export interface InheritanceStressDeps {
  workspace: Workspace;
  strokes: StrokeController;
  metrics: Metrics;
  fitRect(rect: Rect): ViewTransform;
  setView(view: ViewTransform): void;
  /** Bytes the renderer holds on the GPU right now. */
  gpuBytes(): number;
}

export type Shape = 'chain' | 'fan-out';

/** Canvas size for stress canvases: big enough to span several tiles, small enough for 21 of them. */
const SIZE = { width: 1024, height: 1024 };
const GAP = 200;
/** Real input arrives over many frames; this many samples per frame is roughly a quick stroke at 120 Hz. */
const SAMPLES_PER_FRAME = 4;
const SAMPLES_PER_STROKE = 48;

/** Build a chain or fan-out right of everything already there, and show all of it. Returns its canvases, root first. */
export function buildGroup(deps: InheritanceStressDeps, shape: Shape, size: number): CanvasId[] {
  const ws = deps.workspace;
  const existing = union(ws.canvases.map((c) => c.placement));
  const x0 = existing ? existing.x + existing.width + GAP * 4 : 0;
  const y0 = existing ? existing.y : 0;
  const count = size + 1;
  // Chains run left to right, wrapping; a fan-out puts the root first in a grid.
  const columns = shape === 'chain' ? Math.min(count, 6) : Math.ceil(Math.sqrt(count));
  const ids: CanvasId[] = [];
  for (let i = 0; i < count; i++) {
    const at = { x: x0 + (i % columns) * (SIZE.width + GAP), y: y0 + Math.floor(i / columns) * (SIZE.height + GAP) };
    const name = i === 0 ? `${shape} root` : `${shape} ${i}`;
    const doc = ws.createCanvas(SIZE, at, name);
    ids.push(doc.id);
    if (i === 0) continue;
    const source = shape === 'chain' ? ids[i - 1]! : ids[0]!;
    ws.connect(doc.id, source);
    mix(ws, doc.id, i);
  }
  const placements = ids.map((id) => ws.canvas(id).placement);
  deps.setView(deps.fitRect(union(placements)!));
  return ids;
}

/** A different, deterministic mix of block settings for inheritor `i`. */
function mix(ws: Workspace, id: CanvasId, i: number): void {
  const effects: Effect[][] = [[], [{ kind: 'grayscale' }], [{ kind: 'invert' }], [{ kind: 'posterize', levels: 5 }], [{ kind: 'grayscale' }, { kind: 'posterize', levels: 3 }]];
  ws.setBlock(id, {
    effects: effects[i % effects.length]!,
    opacity: 0.85 + 0.15 * (i % 2),
    blendMode: i % 3 === 2 ? 'multiply' : 'normal',
  });
  if (i % 2 === 0) {
    const doc = ws.canvas(id);
    ws.placeBlock(id, {
      x: doc.width / 2 + ((i % 3) - 1) * 40,
      y: doc.height / 2,
      scale: 0.9,
      rotation: ((i % 5) - 2) * 0.1,
      flipX: i % 4 === 0,
    });
  }
}

export interface StressRunResult {
  shape: Shape;
  size: number;
  strokes: number;
  /** Source change → inheritor caught up, by chain depth (ms). */
  propagationByDepth: Record<number, Stats>;
  /** The deepest inheritor caught up per frame (ms). */
  chainEnd: Stats;
  frameInterval: Stats;
  /** Frames during which inheritors still had pending changes. */
  framesWithStale: number;
  peakGpuBytes: number;
}

/** Draw `strokes` scripted strokes on `rootId`, measuring from a clean slate. */
export async function strokeRoot(deps: InheritanceStressDeps, shape: Shape, size: number, rootId: CanvasId, strokes: number): Promise<StressRunResult> {
  const m = deps.metrics;
  await nextFrame(); // let the build settle before measuring
  await settle();
  m.reset();
  let peakGpu = deps.gpuBytes();
  const root = deps.workspace.canvas(rootId);
  for (let s = 0; s < strokes; s++) {
    const y = root.y + ((s + 0.5) / strokes) * root.height;
    const points = Array.from({ length: SAMPLES_PER_STROKE }, (_, i) => {
      const t = i / (SAMPLES_PER_STROKE - 1);
      return { x: root.x + root.width * (0.1 + 0.8 * t), y: y + Math.sin(t * 9 + s) * 60, pressure: 0.3 + 0.6 * Math.sin(t * Math.PI) };
    });
    deps.strokes.begin(sample(points[0]!));
    for (let i = 1; i < points.length; i += SAMPLES_PER_FRAME) {
      deps.strokes.move(points.slice(i, i + SAMPLES_PER_FRAME).map(sample), []);
      await nextFrame();
      peakGpu = Math.max(peakGpu, deps.gpuBytes());
    }
    deps.strokes.end();
    await nextFrame();
  }
  await settle(); // let the last stroke reach the end of the chain
  const summary = m.summary();
  const result: StressRunResult = {
    shape,
    size,
    strokes,
    propagationByDepth: Object.fromEntries(m.propagationByDepth()),
    chainEnd: summary.chainEnd,
    frameInterval: summary.frameInterval,
    framesWithStale: m.frames.filter((f) => f.staleInheritors > 0).length,
    peakGpuBytes: peakGpu,
  };
  m.stressRuns.push(result);
  return result;
}

/** One line for the banner. */
export function describeRun(r: StressRunResult): string {
  const f = (v: number | null) => (v === null ? '—' : v.toFixed(1));
  const depths = Object.entries(r.propagationByDepth)
    .map(([d, s]) => `d${d} ${f(s.p95)}`)
    .join(' · ');
  return (
    `${r.shape} ${r.size}: chain end p50 ${f(r.chainEnd.p50)} / p95 ${f(r.chainEnd.p95)} ms · ` +
    `frame p50 ${f(r.frameInterval.p50)} / p95 ${f(r.frameInterval.p95)} ms · p95 by depth: ${depths || '—'}. Export JSON for details.`
  );
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/** A few frames with nothing new, so queued work (and chains) can finish. */
async function settle(frames = 20): Promise<void> {
  for (let i = 0; i < frames; i++) await nextFrame();
}

function sample(p: { x: number; y: number; pressure: number }): PenSample {
  return {
    x: p.x, y: p.y, pressure: p.pressure, hasRealPressure: true, tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null,
    twist: 0, tangentialPressure: 0, timeStamp: performance.now(), kind: 'pen', isEraser: false, isPredicted: false,
  };
}
