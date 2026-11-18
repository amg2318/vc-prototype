import './style.css';
import { buildCanvasState } from './app/compositeState';
import { StrokeController, type ActiveStroke } from './app/strokeController';
import { Controls } from './debug/controls';
import { buildExport, isStandalone, saveMeasurements, type SessionInfo } from './debug/exportMeasurements';
import { Hud } from './debug/hud';
import { Metrics } from './debug/metrics';
import { createStressPanel } from './debug/stress';
import type { Editor } from './document/editor';
import { hitTest, union, visibleWorkspaceRect } from './workspace/coords';
import { Workspace } from './workspace/workspace';
import { blockBrowserGestures } from './input/blockBrowserGestures';
import { PointerInput, inputCapabilities, type EyedropperPhase } from './input/pointerInput';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createRenderer, requestedRenderer } from './render/createRenderer';
import { ToolState, type Tool } from './tools/tools';
import { rgbFromPremultiplied8 } from './ui/color';
import { ColorPicker } from './ui/colorPicker';
import { LayersPanel } from './ui/layersPanel';
import { Loupe } from './ui/loupe';
import { installShortcuts } from './ui/shortcuts';
import { CanvasLabels } from './ui/canvasLabels';
import { Thumbnails } from './ui/thumbnails';
import { Toolbar } from './ui/toolbar';
import { IDENTITY_VIEW, docToClipMatrix, fitRectToView, type ViewTransform } from './viewport/viewport';

async function main(): Promise<void> {
  const ui = document.getElementById('ui')!;
  const initialCanvas = document.getElementById('stage') as HTMLCanvasElement;

  const { renderer, fallbackReason, canvas } = await createRenderer(initialCanvas, requestedRenderer(location.search));
  blockBrowserGestures(canvas);

  const workspace = new Workspace();
  seedCanvases(workspace, Number(new URLSearchParams(location.search).get('canvases') ?? 1));
  /** The selected canvas's editor; null when no canvas is selected. */
  const active = (): Editor | null => workspace.activeEditor;
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
    const info = renderer.render({
      workspaceToClip: docToClipMatrix(view, cssWidth, cssHeight),
      visible: visibleWorkspaceRect(view, cssWidth, cssHeight),
      canvasPxPerDevicePx: 1 / (view.scale * window.devicePixelRatio),
    });
    metrics.frameRendered(rafTime, performance.now() - start, info);
    labels.update(workspace.canvases, workspace.activeCanvasId, view, cssWidth, cssHeight);
  }

  /** Zoom to fit every canvas. */
  function fitAll(): ViewTransform {
    const all = union(workspace.canvases.map((c) => c.placement)) ?? { x: 0, y: 0, width: 1, height: 1 };
    return fitRectToView(all, cssWidth, cssHeight);
  }

  function setView(next: ViewTransform): void {
    view = next;
    requestFrame();
  }

  // --- workspace → compositor ----------------------------------------------

  let liveStroke: ActiveStroke | null = null;
  function updateCompositeState(): void {
    renderer.setCanvases(
      workspace.canvases.map((doc) => buildCanvasState(doc, liveStroke?.canvasId === doc.id ? liveStroke : null)),
    );
    requestFrame();
  }
  const thumbnails = new Thumbnails(workspace, renderer, requestFrame);
  const labels = new CanvasLabels();
  workspace.onChange((change) => {
    updateCompositeState();
    renderer.invalidateTiles(change.canvasId, change.tiles);
    for (const id of change.layers) thumbnails.schedule(id);
    refreshUi();
  });
  updateCompositeState();

  const strokes = new StrokeController(renderer, tools, {
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
  }, (p) => {
    // A stroke draws on the topmost canvas under its first point (and selects it).
    const doc = hitTest(workspace.canvases, p);
    if (!doc) return null;
    workspace.setActiveCanvas(doc.id);
    return workspace.editor(doc.id);
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
      view = fitAll();
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
    eyedropper(phase, screen) {
      sampleColor(phase, screen);
      if (phase === 'end') tools.returnFromEyedropper();
    },
    tap(fingers) {
      if (fingers === 2) workspace.undo();
      else workspace.redo();
    },
  });

  // --- eyedropper: samples what is on screen (all visible layers + paper) ------------

  const loupe = new Loupe();
  let sampleSerial = 0;
  let colorBeforePick = tools.brush.color;
  function sampleColor(phase: EyedropperPhase, screen: { x: number; y: number }): void {
    if (phase === 'end' || phase === 'cancel') {
      loupe.hide();
      if (phase === 'cancel') {
        sampleSerial++; // ignore readbacks still on their way
        tools.setColor(colorBeforePick);
        picker.setColor(colorBeforePick);
      }
      return;
    }
    if (phase === 'start') colorBeforePick = [...tools.brush.color];
    loupe.show(screen, null);
    const serial = ++sampleSerial;
    const dpr = window.devicePixelRatio || 1;
    void renderer.readScreenPixel(screen.x * dpr, screen.y * dpr).then((rgba) => {
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
    const s = workspace.stats();
    const a = active()?.stats();
    return [
      `canvases ${s.canvases} · active: ${a ? `${a.tileEntries} tiles in ${a.layers} layers` : 'none'}`,
      `slots ${s.usedSlots}/${s.capacitySlots} · pages ${renderer.memory().layerPages}`,
      `gpu memory ≈ ${mb(renderer.memory().bytes)} (composite pages ${renderer.memory().compositePages})`,
      `history ${s.historySteps} undo / ${s.redoSteps} redo · ${mb(s.historyBytes)}`,
      `zoom ${Math.round(view.scale * 100)}%  dpr ${window.devicePixelRatio}  canvas ${canvas.width}×${canvas.height}`,
      `coalesced ${inputCapabilities.coalescedEvents ? 'yes' : 'no'}  predicted ${inputCapabilities.predictedEvents ? 'yes' : 'no'}  ${isStandalone() ? 'home-screen app' : 'browser tab'}`,
    ];
  });

  const controls = new Controls(
    () => tools.editableSettings,
    () => (tools.paintingTool === 'eraser' ? 'Eraser' : 'Brush'),
    {
      fitView() {
        setView(fitAll());
      },
      toggleHud() {
        hud.setVisible(!hud.visible);
      },
      exportMeasurements() {
        const label = prompt('Label for this run (e.g. "webgpu low-power-off tab"):', renderer.kind) ?? '';
        void saveMeasurements(buildExport(metrics, session(), tools.brush, label, {
          ...workspace.stats(),
          atlasPages: renderer.memory().layerPages,
          gpuMemoryBytes: renderer.memory().bytes,
        }), label);
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
  const layersPanel = new LayersPanel(active, thumbnails);
  const toolbar = new Toolbar({
    selectTool,
    undo: () => workspace.undo(),
    redo: () => workspace.redo(),
    toggleColorPicker: () => picker.toggle(),
    toggleLayers: () => layersPanel.setVisible(!layersPanel.visible),
  });

  function refreshUi(): void {
    toolbar.update({
      tool: tools.current,
      color: tools.brush.color,
      canUndo: workspace.history.canUndo,
      canRedo: workspace.history.canRedo,
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

  if (new URLSearchParams(location.search).has('stress')) {
    controls.debugBody.append(
      createStressPanel({
        get editor() {
          return active() ?? workspace.editor(workspace.canvases[0]!.id);
        },
        strokes,
        tools,
        report: (m) => showBanner(m, true),
      }),
    );
  }

  ui.append(labels.element, toolbar.element, picker.element, controls.element, layersPanel.element, hud.element, loupe.element, banner);
  refreshUi();

  installShortcuts({
    undo: () => workspace.undo(),
    redo: () => workspace.redo(),
    selectTool,
    resizeBrush: (factor) => tools.adjustSize(factor),
    newLayer: () => active()?.addLayer(),
    toggleHud: () => hud.setVisible(!hud.visible),
  });

  new ResizeObserver(resize).observe(canvas);
  watchDevicePixelRatio();
  resize();
  hud.setVisible(true); // after the first resize, so the HUD never shows the pre-fit view
}

/**
 * The starting canvases: one 4096² canvas, or with `?canvases=N` a grid of
 * N A4 canvases (for testing many canvases before the canvas UI exists).
 */
function seedCanvases(workspace: Workspace, count: number): void {
  const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
  const size = n === 1 ? { width: 4096, height: 4096 } : { width: 2480, height: 3508 };
  const columns = Math.ceil(Math.sqrt(n));
  const gap = 300;
  for (let i = 0; i < n; i++) {
    const doc = workspace.newCanvas(size, `Canvas ${i + 1}`);
    doc.x = (i % columns) * (size.width + gap);
    doc.y = Math.floor(i / columns) * (size.height + gap);
    workspace.attachCanvas(doc);
  }
  workspace.activeCanvasId = workspace.canvases[0]!.id;
}

main().catch((error: unknown) => {
  console.error(error);
  const message = document.createElement('pre');
  message.className = 'fatal';
  message.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
});

registerServiceWorker();
