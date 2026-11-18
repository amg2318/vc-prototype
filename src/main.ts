import './style.css';
import { DEFAULT_BRUSH, type BrushSettings } from './brush/brushSettings';
import { StrokeEngine } from './brush/strokeEngine';
import { createControls } from './debug/controls';
import { buildExport, isStandalone, saveMeasurements, type SessionInfo } from './debug/exportMeasurements';
import { Hud } from './debug/hud';
import { Metrics } from './debug/metrics';
import { blockBrowserGestures } from './input/blockBrowserGestures';
import type { PenSample } from './input/penSample';
import { PointerInput, inputCapabilities } from './input/pointerInput';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createRenderer, requestedRenderer } from './render/createRenderer';
import type { StrokeStyle } from './render/renderer';
import { IDENTITY_VIEW, docToClipMatrix, fitToView, type ViewTransform } from './viewport/viewport';

/** Phase 0 has no layers, so the eraser paints the white document background. */
const ERASER_COLOR: [number, number, number] = [1, 1, 1];

async function main(): Promise<void> {
  const ui = document.getElementById('ui')!;
  const initialCanvas = document.getElementById('stage') as HTMLCanvasElement;

  const { renderer, fallbackReason, canvas } = await createRenderer(initialCanvas, requestedRenderer(location.search));
  blockBrowserGestures(canvas);

  const brush: BrushSettings = { ...DEFAULT_BRUSH, color: [...DEFAULT_BRUSH.color] };
  const engine = new StrokeEngine(brush);
  const metrics = new Metrics();

  let view: ViewTransform = IDENTITY_VIEW;
  let cssWidth = 1;
  let cssHeight = 1;
  let hasFitted = false;

  // --- render loop: only runs when something changed ----------------------

  let framePending = false;
  function requestFrame(): void {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(frame);
  }
  function frame(rafTime: number): void {
    framePending = false;
    const start = performance.now();
    const info = renderer.render(docToClipMatrix(view, cssWidth, cssHeight));
    metrics.frameRendered(rafTime, performance.now() - start, info);
  }

  function setView(next: ViewTransform): void {
    view = next;
    requestFrame();
  }

  // --- canvas size and devicePixelRatio -----------------------------------

  function resize(): void {
    cssWidth = Math.max(1, canvas.clientWidth);
    cssHeight = Math.max(1, canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(renderer.maxCanvasSize, Math.round(cssWidth * dpr));
    const height = Math.min(renderer.maxCanvasSize, Math.round(cssHeight * dpr));
    renderer.resize(width, height);
    input.updateOrigin();
    if (!hasFitted) {
      view = fitToView(renderer.documentWidth, renderer.documentHeight, cssWidth, cssHeight);
      hasFitted = true;
    }
    requestFrame();
  }

  // devicePixelRatio changes (browser zoom, moving to another monitor) don't
  // fire `resize` everywhere; a resolution media query does.
  function watchDevicePixelRatio(): void {
    const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        resize();
        watchDevicePixelRatio();
      },
      { once: true },
    );
  }

  // --- input → brush → renderer -------------------------------------------

  function strokeStyleFor(sample: PenSample): StrokeStyle {
    return { color: sample.isEraser ? ERASER_COLOR : brush.color, opacity: brush.opacity };
  }

  const input = new PointerInput(canvas, {
    getView: () => view,
    setView,
    strokeBegin(sample) {
      metrics.counters.strokes++;
      renderer.beginStroke(strokeStyleFor(sample));
      const dabs = engine.begin(sample, brush);
      renderer.addStrokeDabs(dabs);
      metrics.noteInput([sample], sample.timeStamp);
      metrics.noteDabs(dabs.length, 0);
      requestFrame();
    },
    strokeMove(samples, predicted) {
      const dabs = engine.add(samples);
      const predictedDabs = engine.predict(predicted);
      renderer.addStrokeDabs(dabs);
      renderer.setPredictedDabs(predictedDabs);
      metrics.noteInput(samples, samples[samples.length - 1]?.timeStamp ?? performance.now());
      metrics.noteDabs(dabs.length, predictedDabs.length);
      requestFrame();
    },
    strokeEnd(cancelled) {
      // A cancelled stroke (e.g. the OS claimed the touch) is still kept: losing
      // what was drawn is worse than keeping it. The HUD counts cancellations.
      if (cancelled) metrics.counters.cancelledStrokes++;
      renderer.addStrokeDabs(engine.end());
      renderer.endStroke();
      requestFrame();
    },
    palmRejected() {
      metrics.counters.palmRejections++;
    },
  });

  // --- debug UI -------------------------------------------------------------

  const rendererLabel = (): string =>
    renderer.kind === 'webgpu' ? 'WebGPU' : `WebGL2${fallbackReason ? ` (fallback: ${fallbackReason})` : ''}`;

  const session = (): SessionInfo => ({
    renderer: renderer.kind,
    fallbackReason,
    devicePixelRatio: window.devicePixelRatio,
    cssSize: { width: cssWidth, height: cssHeight },
    backingSize: { width: canvas.width, height: canvas.height },
    inputCapabilities,
  });

  const hud = new Hud(metrics, rendererLabel, () => [
    `zoom ${Math.round(view.scale * 100)}%  dpr ${window.devicePixelRatio}  canvas ${canvas.width}×${canvas.height}`,
    `coalesced ${inputCapabilities.coalescedEvents ? 'yes' : 'no'}  predicted ${inputCapabilities.predictedEvents ? 'yes' : 'no'}  ${isStandalone() ? 'home-screen app' : 'browser tab'}`,
  ]);

  const controls = createControls(brush, {
    clearCanvas() {
      renderer.clearDocument();
      requestFrame();
    },
    fitView() {
      setView(fitToView(renderer.documentWidth, renderer.documentHeight, cssWidth, cssHeight));
    },
    toggleHud() {
      hud.setVisible(!hud.visible);
    },
    exportMeasurements() {
      const label = prompt('Label for this run (e.g. "webgpu low-power-off tab"):', renderer.kind) ?? '';
      void saveMeasurements(buildExport(metrics, session(), brush, label), label);
    },
    resetMeasurements() {
      metrics.reset();
    },
    setRotationEnabled(enabled) {
      input.touch.allowRotation = enabled;
    },
  });

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.hidden = true;
  renderer.onLost = (message) => {
    banner.textContent = message;
    banner.hidden = false;
  };

  ui.append(controls, hud.element, banner);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    if (e.key === 'h') hud.setVisible(!hud.visible);
  });

  new ResizeObserver(resize).observe(canvas);
  watchDevicePixelRatio();
  resize();
  hud.setVisible(true); // after the first resize, so the HUD never shows the pre-fit view
}

main().catch((error: unknown) => {
  console.error(error);
  const message = document.createElement('pre');
  message.className = 'fatal';
  message.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
});

registerServiceWorker();
