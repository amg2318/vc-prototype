import './style.css';
import { buildCompositeState } from './app/compositeState';
import { StrokeController, type ActiveStroke } from './app/strokeController';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from './config';
import { Controls } from './debug/controls';
import { buildExport, isStandalone, saveMeasurements, type SessionInfo } from './debug/exportMeasurements';
import { Hud } from './debug/hud';
import { Metrics } from './debug/metrics';
import { Editor } from './document/editor';
import { blockBrowserGestures } from './input/blockBrowserGestures';
import { PointerInput, inputCapabilities } from './input/pointerInput';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createRenderer, requestedRenderer } from './render/createRenderer';
import { ToolState, type Tool } from './tools/tools';
import { rgbFromPremultiplied8 } from './ui/color';
import { ColorPicker } from './ui/colorPicker';
import { LayersPanel } from './ui/layersPanel';
import { Loupe } from './ui/loupe';
import { installShortcuts } from './ui/shortcuts';
import { Thumbnails } from './ui/thumbnails';
import { Toolbar } from './ui/toolbar';
import { IDENTITY_VIEW, docToClipMatrix, fitToView, type ViewTransform } from './viewport/viewport';

async function main(): Promise<void> {
  const ui = document.getElementById('ui')!;
  const initialCanvas = document.getElementById('stage') as HTMLCanvasElement;

  const { renderer, fallbackReason, canvas } = await createRenderer(initialCanvas, requestedRenderer(location.search));
  blockBrowserGestures(canvas);

  const editor = new Editor();
  const tools = new ToolState();
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
    const texelsPerPixel = 1 / (view.scale * window.devicePixelRatio);
    const info = renderer.render(docToClipMatrix(view, cssWidth, cssHeight), texelsPerPixel);
    metrics.frameRendered(rafTime, performance.now() - start, info);
  }

  function setView(next: ViewTransform): void {
    view = next;
    requestFrame();
  }

  // --- document → compositor ----------------------------------------------

  let liveStroke: ActiveStroke | null = null;
  function updateCompositeState(): void {
    renderer.setCompositeState(buildCompositeState(editor.doc, liveStroke));
    requestFrame();
  }
  const thumbnails = new Thumbnails(editor, renderer, requestFrame);
  editor.onChange((change) => {
    updateCompositeState();
    renderer.invalidateTiles(change.tiles);
    for (const id of change.layers) thumbnails.schedule(id);
    refreshUi();
  });
  updateCompositeState();

  const strokes = new StrokeController(editor, renderer, tools, {
    liveStrokeChanged(stroke) {
      liveStroke = stroke;
      updateCompositeState();
    },
    dabsQueued(real, predicted) {
      metrics.noteDabs(real, predicted);
    },
    poolFull() {
      showBanner('Tile memory is full: that stroke could not be kept. Delete or clear layers to free memory.');
    },
    requestFrame,
  });

  // --- canvas size and devicePixelRatio -----------------------------------

  function resize(): void {
    cssWidth = Math.max(1, canvas.clientWidth);
    cssHeight = Math.max(1, canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(
      Math.min(renderer.maxCanvasSize, Math.round(cssWidth * dpr)),
      Math.min(renderer.maxCanvasSize, Math.round(cssHeight * dpr)),
    );
    input.updateOrigin();
    if (!hasFitted) {
      view = fitToView(CANVAS_WIDTH, CANVAS_HEIGHT, cssWidth, cssHeight);
      hasFitted = true;
    }
    requestFrame();
  }

  // devicePixelRatio changes don't fire `resize` everywhere; a resolution media query does.
  function watchDevicePixelRatio(): void {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        resize();
        watchDevicePixelRatio();
      },
      { once: true },
    );
  }

  // --- input ----------------------------------------------------------------

  const input = new PointerInput(canvas, {
    getView: () => view,
    setView,
    strokeBegin(sample) {
      metrics.counters.strokes++;
      metrics.noteInput([sample], sample.timeStamp);
      strokes.begin(sample);
    },
    strokeMove(samples, predicted) {
      metrics.noteInput(samples, samples[samples.length - 1]?.timeStamp ?? performance.now());
      strokes.move(samples, predicted);
    },
    strokeEnd(cancelled) {
      // A cancelled stroke (e.g. the OS claimed the touch) is still kept: losing
      // what was drawn is worse than keeping it. The HUD counts cancellations.
      if (cancelled) metrics.counters.cancelledStrokes++;
      strokes.end();
    },
    palmRejected() {
      metrics.counters.palmRejections++;
    },
    eyedropperActive: () => tools.current === 'eyedropper',
    eyedropper(phase, screen, doc) {
      sampleColor(phase, screen, doc);
      if (phase === 'end') tools.returnFromEyedropper();
    },
  });

  // --- eyedropper: samples the composite (all visible layers + paper) ------------

  const loupe = new Loupe();
  let sampleSerial = 0;
  function sampleColor(phase: 'start' | 'move' | 'end', screen: { x: number; y: number }, doc: { x: number; y: number }): void {
    if (phase === 'end') {
      loupe.hide();
      return;
    }
    loupe.show(screen, null);
    const serial = ++sampleSerial;
    void renderer.readPixel(doc.x, doc.y).then((rgba) => {
      if (serial !== sampleSerial) return; // a newer sample is on its way
      const color = rgbFromPremultiplied8(rgba);
      tools.setColor(color);
      picker.setColor(color);
      if (!loupe.element.hidden) loupe.show(screen, color);
    });
    requestFrame();
  }

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

  const mb = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MB`;
  const hud = new Hud(metrics, rendererLabel, () => {
    const s = editor.stats();
    return [
      `tiles ${s.tileEntries} in ${s.layers} layers · slots ${s.usedSlots}/${s.capacitySlots} · pages ${renderer.pageCount}`,
      `gpu memory ≈ ${mb(renderer.gpuMemoryBytes())}`,
      `history ${s.historySteps} undo / ${s.redoSteps} redo · ${mb(s.historyBytes)}`,
      `zoom ${Math.round(view.scale * 100)}%  dpr ${window.devicePixelRatio}  canvas ${canvas.width}×${canvas.height}`,
      `coalesced ${inputCapabilities.coalescedEvents ? 'yes' : 'no'}  predicted ${inputCapabilities.predictedEvents ? 'yes' : 'no'}  ${isStandalone() ? 'home-screen app' : 'browser tab'}`,
    ];
  });

  const controls = new Controls(
    () => tools.editableSettings,
    () => (tools.current === 'eraser' ? 'Eraser' : 'Brush'),
    {
      fitView() {
        setView(fitToView(CANVAS_WIDTH, CANVAS_HEIGHT, cssWidth, cssHeight));
      },
      toggleHud() {
        hud.setVisible(!hud.visible);
      },
      exportMeasurements() {
        const label = prompt('Label for this run (e.g. "webgpu low-power-off tab"):', renderer.kind) ?? '';
        void saveMeasurements(buildExport(metrics, session(), tools.brush, label), label);
      },
      resetMeasurements() {
        metrics.reset();
      },
      setRotationEnabled(enabled) {
        input.touch.allowRotation = enabled;
      },
    },
  );

  const selectTool = (tool: Tool): void => tools.setTool(tool);
  const picker = new ColorPicker((color) => tools.setColor(color));
  picker.setColor(tools.brush.color);
  const layersPanel = new LayersPanel(editor, thumbnails);
  const toolbar = new Toolbar({
    selectTool,
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    toggleColorPicker: () => picker.toggle(),
    toggleLayers: () => layersPanel.setVisible(!layersPanel.visible),
  });

  function refreshUi(): void {
    toolbar.update({
      tool: tools.current,
      color: tools.brush.color,
      canUndo: editor.history.canUndo,
      canRedo: editor.history.canRedo,
    });
    layersPanel.update();
    picker.setRecentColors(tools.recentColors);
    controls.refresh();
  }
  tools.onChange(refreshUi);

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.hidden = true;
  let bannerTimer = 0;
  function showBanner(message: string, sticky = false): void {
    banner.textContent = message;
    banner.hidden = false;
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = window.setTimeout(() => (banner.hidden = true), 5000);
  }
  renderer.onLost = (message) => showBanner(message, true);

  ui.append(toolbar.element, picker.element, controls.element, layersPanel.element, hud.element, loupe.element, banner);
  refreshUi();

  installShortcuts({
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    selectTool,
    resizeBrush: (factor) => tools.adjustSize(factor),
    newLayer: () => editor.addLayer(),
    toggleHud: () => hud.setVisible(!hud.visible),
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
