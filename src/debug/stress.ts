import type { StrokeController } from '../app/strokeController';
import { MAX_LAYERS } from '../config';
import type { Editor } from '../document/editor';
import type { PenSample } from '../input/penSample';
import type { ToolState } from '../tools/tools';
import { buttons } from './controls';

export interface StressDeps {
  /** The active canvas's editor (strokes are drawn on it). */
  readonly editor: Editor;
  strokes: StrokeController;
  tools: ToolState;
  report(message: string): void;
}

/**
 * Debug-only stress tests (shown with `?stress`). Strokes are synthesised as
 * PenSamples and go through exactly the same path as real input, one stroke
 * per animation frame so the GPU sees a realistic load.
 *
 * They exist to find the tile-pool and history limits on a real device,
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
      const s = deps.editor.stats();
      deps.report(
        `${name}: ${result} in ${((performance.now() - start) / 1000).toFixed(1)} s · ` +
          `${s.usedSlots}/${s.capacitySlots} tile slots · history ${(s.historyBytes / 2 ** 20).toFixed(0)} MB`,
      );
    } finally {
      running = false;
    }
  };

  const wrap = document.createElement('div');
  wrap.className = 'controls-body';
  const title = document.createElement('strong');
  title.textContent = 'Stress tests';
  wrap.append(
    title,
    buttons([
      ['200 strokes', run('200 strokes', () => drawStrokes(deps, 200))],
      ['Fill 32 layers', run('Fill layers', () => fillLayers(deps))],
    ]),
    buttons([
      ['Undo / redo all', run('Undo/redo all', () => undoRedoAll(deps))],
      ['Fill pool', run('Fill pool', () => fillPool(deps))],
    ]),
  );
  return wrap;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

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
    x, y, pressure, tiltX: 0, tiltY: 0, altitudeAngle: null, azimuthAngle: null, twist: 0,
    tangentialPressure: 0, timeStamp: t, pointerType: 'pen', isEraser: false, isPredicted: false,
  };
}

/** One wavy stroke across a random part of the active canvas (in workspace coordinates). */
async function drawOne(deps: StressDeps, rand: () => number, lengthFraction = 0.6): Promise<void> {
  const doc = deps.editor.doc;
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

async function drawStrokes(deps: StressDeps, count: number): Promise<string> {
  const rand = random(1);
  for (let i = 0; i < count; i++) await drawOne(deps, rand);
  return `${count} strokes`;
}

async function fillLayers(deps: StressDeps): Promise<string> {
  const rand = random(2);
  let layers = 0;
  while (deps.editor.canAddLayer) {
    deps.editor.addLayer();
    for (let i = 0; i < 4; i++) await drawOne(deps, rand);
    layers++;
  }
  return `added ${layers} layers (max ${MAX_LAYERS})`;
}

async function undoRedoAll(deps: StressDeps): Promise<string> {
  let steps = 0;
  while (deps.editor.history.canUndo) {
    deps.editor.undo();
    steps++;
    await nextFrame();
  }
  while (deps.editor.history.canRedo) {
    deps.editor.redo();
    await nextFrame();
  }
  return `${steps} steps undone and redone`;
}

/** Big strokes until the pool refuses one (or 2000 strokes). */
async function fillPool(deps: StressDeps): Promise<string> {
  const rand = random(3);
  const size = deps.tools.brush.diameter;
  deps.tools.brush.diameter = 400;
  let strokes = 0;
  try {
    let lastUsed = -1;
    while (strokes < 2000) {
      if (deps.editor.canAddLayer && strokes % 10 === 0) deps.editor.addLayer();
      await drawOne(deps, rand, 0.9);
      strokes++;
      const used = deps.editor.stats().usedSlots;
      if (used === lastUsed && !deps.editor.canAddLayer) break; // nothing more fits
      lastUsed = used;
    }
  } finally {
    deps.tools.brush.diameter = size;
    deps.tools.adjustSize(1); // no change in size; just tells the UI to refresh
  }
  return `${strokes} strokes`;
}
