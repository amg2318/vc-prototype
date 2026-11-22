import type { StrokeController } from '../app/strokeController';
import { MAX_LAYERS } from '../config';
import type { Editor } from '../document/editor';
import type { PenSample } from '../input/penSample';
import type { ToolState } from '../tools/tools';
import type { ViewTransform } from '../viewport/viewport';
import { union, type Rect } from '../workspace/coords';
import { CANVAS_PRESETS } from '../workspace/presets';
import type { Workspace } from '../workspace/workspace';
import { buttons } from './controls';
import { buildGroup, describeRun, strokeRoot, type Shape } from './inheritanceStress';
import type { Metrics } from './metrics';

export interface StressDeps {
  /** The active canvas's editor (single-canvas tests draw on it). */
  readonly editor: Editor;
  workspace: Workspace;
  strokes: StrokeController;
  tools: ToolState;
  metrics: Metrics;
  /** The view that shows all of `rect`. */
  fitRect(rect: Rect): ViewTransform;
  setView(view: ViewTransform): void;
  report(message: string): void;
  /** Bytes the renderer holds on the GPU right now. */
  gpuBytes(): number;
}

/**
 * Debug-only stress tests (shown with `?stress`). Strokes are synthesised as
 * PenSamples and go through exactly the same path as real input, one stroke
 * per animation frame so the GPU sees a realistic load.
 *
 * "Build workspace" creates N canvases of a preset size with M layers of
 * scripted strokes each; "Auto-pan" then moves the view across every canvas
 * and back (resetting the stats first), so the JSON export holds frame
 * times, memory and tile reload times for exactly that pan.
 *
 * They exist to find memory limits and eviction costs on a real device,
 * not to measure latency (synthetic input has no real timestamps).
 */
export function createStressPanel(deps: StressDeps): HTMLElement {
  let running = false;
  const run = (name: string, task: () => Promise<string>) => async () => {
    if (running) return;
    running = true;
    const start = performance.now();
    try {
      const result = await task();
      deps.report(`${name}: ${result} (${((performance.now() - start) / 1000).toFixed(1)} s)`);
    } finally {
      running = false;
    }
  };

  const count = numberField('Canvases', 20, 1, 200);
  const layers = numberField('Layers each', 4, 1, MAX_LAYERS);
  const strokesPerLayer = numberField('Strokes per layer', 6, 1, 100);
  const preset = document.createElement('select');
  for (const p of CANVAS_PRESETS) preset.append(new Option(p.name, p.name));
  const presetRow = document.createElement('label');
  presetRow.className = 'row';
  presetRow.append(Object.assign(document.createElement('span'), { textContent: 'Preset' }), preset);

  const depth = numberField('Chain depth', 5, 1, 10);
  const fanOut = numberField('Fan-out', 10, 1, 20);
  const rootStrokes = numberField('Root strokes', 10, 1, 100);
  const inheritanceRun = async (shape: Shape, size: number): Promise<string> => {
    const ids = buildGroup(deps, shape, size);
    return describeRun(await strokeRoot(deps, shape, size, ids[0]!, rootStrokes.value()));
  };

  const wrap = document.createElement('div');
  wrap.className = 'controls-body';
  const title = document.createElement('strong');
  title.textContent = 'Stress tests';
  wrap.append(
    title,
    count.row,
    presetRow,
    layers.row,
    strokesPerLayer.row,
    buttons([
      ['Build workspace', run('Build workspace', () => {
        const size = CANVAS_PRESETS.find((p) => p.name === preset.value) ?? CANVAS_PRESETS[0]!;
        return buildWorkspace(deps, count.value(), size, layers.value(), strokesPerLayer.value());
      })],
      ['Auto-pan', run('Auto-pan', () => autoPan(deps))],
    ]),
    document.createTextNode('On the selected canvas:'),
    buttons([
      ['200 strokes', run('200 strokes', () => drawStrokes(deps, 200))],
      ['Fill 32 layers', run('Fill layers', () => fillLayers(deps))],
    ]),
    buttons([['Undo / redo all', run('Undo/redo all', () => undoRedoAll(deps))]]),
    document.createTextNode('Inheritance (Phase 3): build, then stroke the root:'),
    depth.row,
    fanOut.row,
    rootStrokes.row,
    buttons([
      ['Chain', run('Chain', () => inheritanceRun('chain', depth.value()))],
      ['Fan-out', run('Fan-out', () => inheritanceRun('fan-out', fanOut.value()))],
    ]),
  );
  return wrap;
}

function numberField(label: string, initial: number, min: number, max: number) {
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', min: String(min), max: String(max), value: String(initial) });
  input.style.width = '5em';
  const row = document.createElement('label');
  row.className = 'row';
  row.append(Object.assign(document.createElement('span'), { textContent: label }), input);
  return { row, value: () => Math.max(min, Math.min(max, Math.round(Number(input.value) || min))) };
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/** Deterministic pseudo-random numbers, so runs are comparable. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sample(x: number, y: number, pressure: number, t: number): PenSample {
  return {
    x, y, pressure, hasRealPressure: true, tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null, twist: 0,
    tangentialPressure: 0, timeStamp: t, kind: 'pen', isEraser: false, isPredicted: false,
  };
}

/** One wavy stroke across a random part of a canvas (in workspace coordinates). */
async function drawOne(deps: StressDeps, editor: Editor, rand: () => number, lengthFraction = 0.6): Promise<void> {
  const doc = editor.doc;
  const length = doc.width * lengthFraction;
  const x0 = doc.x + rand() * doc.width * 0.4;
  const y0 = doc.y + rand() * doc.height;
  const amp = 50 + rand() * 300;
  const steps = 60;
  const now = performance.now();
  deps.strokes.begin(sample(x0, y0, 0.3, now));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = sample(x0 + t * length, y0 + Math.sin(t * 8 + x0 - doc.x) * amp, 0.3 + 0.7 * Math.sin(t * Math.PI), now + i * 4);
    deps.strokes.move([p], []);
  }
  deps.strokes.end();
  await nextFrame();
}

/** N canvases in a grid, right of everything already there, each with M layers of strokes. */
async function buildWorkspace(
  deps: StressDeps,
  count: number,
  size: { width: number; height: number },
  layers: number,
  strokesPerLayer: number,
): Promise<string> {
  const ws = deps.workspace;
  const rand = random(4);
  const gap = 300;
  const existing = union(ws.canvases.map((c) => c.placement));
  const x0 = existing ? existing.x + existing.width + gap : 0;
  const y0 = existing ? existing.y : 0;
  const columns = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const at = { x: x0 + (i % columns) * (size.width + gap), y: y0 + Math.floor(i / columns) * (size.height + gap) };
    const doc = ws.createCanvas(size, at, `Stress ${i + 1}`);
    deps.setView(deps.fitRect(doc.placement));
    const editor = ws.editor(doc.id);
    for (let l = 0; l < layers; l++) {
      if (l > 0 && !editor.addLayer()) break;
      for (let s = 0; s < strokesPerLayer; s++) await drawOne(deps, editor, rand);
    }
    deps.report(`Build workspace: canvas ${i + 1} / ${count}…`);
  }
  const s = ws.stats();
  return `${count} canvases × ${layers} layers · ${s.usedSlots} tiles · undo ${(s.historyBytes / 2 ** 20).toFixed(0)} MB`;
}

/**
 * Fly the view from canvas to canvas (top-left to bottom-right, then back),
 * each canvas filling the screen. Resets the stats first so an export right
 * after covers only the pan.
 */
async function autoPan(deps: StressDeps, msPerCanvas = 1200): Promise<string> {
  const canvases = [...deps.workspace.canvases].sort((a, b) => a.y - b.y || a.x - b.x);
  if (canvases.length < 2) return 'needs at least two canvases';
  const stops = canvases.map((c) => deps.fitRect(c.placement));
  const path = [...stops, ...stops.slice(0, -1).reverse()];
  deps.metrics.reset();
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const start = await nextFrame();
    for (let now = start; now - start < msPerCanvas; now = await nextFrame()) {
      const t = (now - start) / msPerCanvas;
      const ease = t * t * (3 - 2 * t); // smoothstep: slow at each canvas, fast between
      deps.setView({
        scale: from.scale + (to.scale - from.scale) * ease,
        rotation: from.rotation,
        tx: from.tx + (to.tx - from.tx) * ease,
        ty: from.ty + (to.ty - from.ty) * ease,
      });
    }
    deps.setView(to);
  }
  const m = deps.metrics;
  const summary = m.summary();
  const reloads = m.residency().reloadMs;
  // The renderer's totals run since page load: report the change during the pan.
  const first = m.frames[0];
  const last = m.frames.at(-1);
  const during = (key: 'evictions' | 'reloads') => (first && last ? last[key] - first[key] : 0);
  const peakGpu = Math.max(0, ...m.memory.map((s) => s.gpuBytes));
  const f = (v: number | null) => (v === null ? '—' : v.toFixed(1));
  return (
    `frame ms p50 ${f(summary.frameInterval.p50)} / p95 ${f(summary.frameInterval.p95)} · ` +
    `${during('evictions')} evictions · ${during('reloads')} reloads (reload p95 ${f(reloads.p95)} ms) · ` +
    `peak GPU ${(peakGpu / 2 ** 20).toFixed(0)} MB. Export JSON to keep the details.`
  );
}

async function drawStrokes(deps: StressDeps, count: number): Promise<string> {
  const rand = random(1);
  const editor = deps.editor;
  for (let i = 0; i < count; i++) await drawOne(deps, editor, rand);
  return `${count} strokes`;
}

async function fillLayers(deps: StressDeps): Promise<string> {
  const rand = random(2);
  const editor = deps.editor;
  let layers = 0;
  while (editor.canAddLayer) {
    editor.addLayer();
    for (let i = 0; i < 4; i++) await drawOne(deps, editor, rand);
    layers++;
  }
  return `added ${layers} layers (max ${MAX_LAYERS})`;
}

async function undoRedoAll(deps: StressDeps): Promise<string> {
  const ws = deps.workspace;
  let steps = 0;
  while (ws.history.canUndo) {
    ws.undo();
    steps++;
    await nextFrame();
  }
  while (ws.history.canRedo) {
    ws.redo();
    await nextFrame();
  }
  return `${steps} steps undone and redone`;
}
