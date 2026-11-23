import './style.css';
import { GESTURES, INHERITANCE_DEPTH_WARNING, TILE_BYTES } from './config';
import { buildCanvasState } from './app/compositeState';
import { StrokeController, type ActiveStroke } from './app/strokeController';
import { Controls } from './debug/controls';
import { buildExport, isStandalone, saveMeasurements, type SessionInfo } from './debug/exportMeasurements';
import { Hud } from './debug/hud';
import { Metrics } from './debug/metrics';
import { createStressPanel } from './debug/stress';
import type { Editor } from './document/editor';
import type { Anchor } from './document/retile';
import { hitTest, union, visibleWorkspaceRect } from './workspace/coords';
import { Workspace } from './workspace/workspace';
import type { PaintDocument } from './document/paintDocument';
import { ProjectSession } from './persistence/projectSession';
import { createStorageWorker, workerClient } from './storage/client';
import { SaveIndicator } from './ui/saveIndicator';
import { HistoryPanel } from './ui/historyPanel';
import { formatBytes, ProjectsPanel } from './ui/projectsPanel';
import { QUOTA_MESSAGE } from './persistence/projectSession';
import { inIosBrowserTab, loadRetention, saveRetention } from './persistence/storageSettings';
import { isQuotaError } from './storage/stores';
import { blockBrowserGestures } from './input/blockBrowserGestures';
import { PointerInput, inputCapabilities, type EyedropperPhase } from './input/pointerInput';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createRenderer, layerBudgetSlots, requestedRenderer } from './render/createRenderer';
import { ToolState, type Tool } from './tools/tools';
import { rgbFromPremultiplied8 } from './ui/color';
import { ColorPicker } from './ui/colorPicker';
import { LayersPanel } from './ui/layersPanel';
import { Loupe } from './ui/loupe';
import { installShortcuts } from './ui/shortcuts';
import { CanvasLabels } from './ui/canvasLabels';
import { CanvasPanel } from './ui/canvasPanel';
import { HIGHLIGHT, selectionOutline } from './ui/selectionOutline';
import { ArrowControls } from './ui/arrowControls';
import { depthWarning } from './ui/arrows';
import { BlockTransformMode } from './ui/blockTransformMode';
import type { OverlayShape } from './render/renderer';
import { UNDO_FEEDBACK_MS, UndoIndicator, edgeIndicator } from './ui/undoIndicator';
import type { Change } from './history/command';
import { snapPosition } from './workspace/snap';
import { Thumbnails } from './ui/thumbnails';
import { Toolbar } from './ui/toolbar';
import { IDENTITY_VIEW, docToClipMatrix, docToScreen, fitRectToView, zoomAt, type ViewTransform } from './viewport/viewport';

async function main(): Promise<void> {
  const ui = document.getElementById('ui')!;
  const initialCanvas = document.getElementById('stage') as HTMLCanvasElement;

  const { renderer, fallbackReason, canvas } = await createRenderer(
    initialCanvas,
    requestedRenderer(location.search),
    layerBudgetSlots(location.search),
  );
  blockBrowserGestures(canvas);

  const workspace = new Workspace();
  renderer.useTileStore(workspace.store);

  let view: ViewTransform = IDENTITY_VIEW;

  // Phase 4: open the last project (saved in OPFS by the storage worker) and keep it saved.
  const storage = workerClient(createStorageWorker());
  const testCanvases = new URLSearchParams(location.search).get('canvases');
  const project = new ProjectSession({
    workspace,
    renderer,
    storage,
    view: () => view,
    newProjectCanvases: (ws) => seedCanvases(ws, Number(testCanvases ?? 1)),
  });
  // `?canvases=N` starts a new project with N canvases (for testing); otherwise the last project opens.
  const savedView = testCanvases ? (await project.create(`Test: ${testCanvases} canvases`), undefined) : await project.openLast();
  project.watchPageLifecycle();
  project.retention = loadRetention();
  // Dev builds only: lets the desktop test scripts inspect renderer state.
  if (import.meta.env.DEV) (window as unknown as { __debug: unknown }).__debug = { renderer, workspace, project, storage };
  /** The selected canvas's editor; null when no canvas is selected. */
  const active = (): Editor | null => workspace.activeEditor;
  const tools = new ToolState();
  const metrics = new Metrics();

  let cssWidth = 1;
  let cssHeight = 1;
  /** A saved camera is used as is; otherwise the first resize fits everything. */
  let hasFitted = savedView !== undefined;
  if (savedView) view = savedView;

  // --- render loop: only runs when something changed ----------------------

  const MEMORY_SAMPLE_MS = 250;
  let lastMemorySample = -Infinity;
  let framePending = false;
  function requestFrame(): void {
    if (framePending) return;
    framePending = true;
    // Hidden pages get no animation frames, but a save started on hiding still needs frames
    // to read tiles back from the GPU: drive them with a timer then.
    if (document.visibilityState === 'hidden') setTimeout(() => frame(performance.now()), 0);
    else requestAnimationFrame(frame);
  }
  function frame(rafTime: number): void {
    framePending = false;
    const start = performance.now();
    const canvasPxPerDevicePx = 1 / (view.scale * window.devicePixelRatio);
    const selected = active()?.doc;
    const overlay: OverlayShape[] = arrowControls.overlay(selected?.id ?? null, canvasPxPerDevicePx);
    if (selected) overlay.push(...selectionOutline(selected.placement, canvasPxPerDevicePx));
    overlay.push(...blockTransform.overlay(canvasPxPerDevicePx));
    if (highlighted && workspace.hasCanvas(highlighted)) {
      overlay.push(...selectionOutline(workspace.canvas(highlighted).placement, canvasPxPerDevicePx, HIGHLIGHT));
    }
    renderer.setOverlay(overlay);
    const info = renderer.render({
      workspaceToClip: docToClipMatrix(view, cssWidth, cssHeight),
      visible: visibleWorkspaceRect(view, cssWidth, cssHeight),
      canvasPxPerDevicePx,
    });
    const memory = renderer.memory();
    metrics.frameRendered(rafTime, performance.now() - start, info, {
      evictions: memory.evictions,
      reloads: memory.reloads,
      reloadTimes: renderer.takeReloadTimes(),
    });
    if (rafTime - lastMemorySample >= MEMORY_SAMPLE_MS) {
      lastMemorySample = rafTime;
      metrics.noteMemory({
        t: rafTime,
        residentTiles: memory.residentTiles,
        gpuBytes: memory.bytes,
        compressedTiles: memory.compressedTiles,
        compressedBytes: memory.compressedBytes,
        historyBytes: workspace.stats().historyBytes,
      });
    }
    labels.update(workspace.canvases, workspace.activeCanvasId, view, cssWidth, cssHeight);
    arrowControls.update(view, cssWidth, cssHeight);
    blockTransform.update(view);
    if (info.moreWork) requestFrame();
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

  function zoomToCanvas(id: string): void {
    if (workspace.hasCanvas(id)) setView(fitRectToView(workspace.canvas(id).placement, cssWidth, cssHeight));
  }

  // --- undo / redo: show where the change happened, without moving the camera ---

  /** Canvas briefly outlined because an undo/redo changed it. */
  let highlighted: string | null = null;
  let highlightTimer = 0;
  const undoIndicator = new UndoIndicator((id) => {
    workspace.setActiveCanvas(id);
    zoomToCanvas(id);
  });

  function undo(): void {
    const activeBefore = workspace.activeCanvasId;
    showWhereChanged(workspace.undo(), '↶', activeBefore);
  }

  function redo(): void {
    const activeBefore = workspace.activeCanvasId;
    showWhereChanged(workspace.redo(), '↷', activeBefore);
  }

  /**
   * Off screen: an arrow chip at the screen edge pointing at the canvas.
   * On screen but not the canvas being worked on: a short amber outline.
   */
  function showWhereChanged(change: Change | null, symbol: string, activeBefore: string | null): void {
    if (!change || !workspace.hasCanvas(change.canvasId)) return;
    const doc = workspace.canvas(change.canvasId);
    const corners = [
      docToScreen(view, { x: doc.x, y: doc.y }),
      docToScreen(view, { x: doc.x + doc.width, y: doc.y }),
      docToScreen(view, { x: doc.x, y: doc.y + doc.height }),
      docToScreen(view, { x: doc.x + doc.width, y: doc.y + doc.height }),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const onScreen = {
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    };
    const edge = edgeIndicator(onScreen, cssWidth, cssHeight, 48);
    if (edge) {
      undoIndicator.show(doc.id, `${symbol} ${doc.name}`, edge);
      return;
    }
    if (doc.id === activeBefore) return; // the change is right where the user is looking
    highlighted = doc.id;
    clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      highlighted = null;
      requestFrame();
    }, UNDO_FEEDBACK_MS / 2);
    requestFrame();
  }

  // --- canvas management -----------------------------------------------------

  /** Snap distance while dragging a canvas, in screen CSS px. */
  const SNAP_PX = 8;
  const SNAP_GRID = 256;
  /** The canvas being dragged by its label: where it started, and the undo merge key for this drag. */
  let canvasDrag: { id: string; from: { x: number; y: number }; key: string } | null = null;
  let dragCount = 0;

  function dragCanvas(id: string, dx: number, dy: number, phase: 'start' | 'move' | 'end'): void {
    if (!workspace.hasCanvas(id)) return;
    const doc = workspace.canvas(id);
    if (phase === 'start') {
      workspace.setActiveCanvas(id);
      canvasDrag = { id, from: { x: doc.x, y: doc.y }, key: `move-canvas-${++dragCount}` };
      return;
    }
    if (phase === 'end' || canvasDrag?.id !== id) {
      canvasDrag = null;
      return;
    }
    const snap = canvasPanel.snapping;
    const others = snap.edges ? workspace.canvases.filter((c) => c.id !== id).map((c) => c.placement) : [];
    const to = snapPosition(
      { x: canvasDrag.from.x + dx, y: canvasDrag.from.y + dy, width: doc.width, height: doc.height },
      others,
      SNAP_PX / view.scale,
      snap.grid ? SNAP_GRID : null,
    );
    workspace.moveCanvas(id, to.x, to.y, canvasDrag.key);
  }

  /** A new canvas goes to the right of everything, and the view moves to it. */
  function createCanvas(size: { width: number; height: number }): void {
    const all = union(workspace.canvases.map((c) => c.placement));
    const at = all ? { x: all.x + all.width + 300, y: all.y } : { x: 0, y: 0 };
    zoomToCanvas(workspace.createCanvas(size, at).id);
  }

  function resizeCanvas(id: string, size: { width: number; height: number }, anchor: Anchor): void {
    const jobs = workspace.resizeCanvas(id, size, anchor);
    if (jobs === null) showBanner('Not enough tile memory to resize this canvas.');
    else renderer.retile(id, jobs);
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
  const labels = new CanvasLabels(() => view, {
    select: (id) => {
      arrowControls.select(null);
      if (id !== blockTransform.canvasId) blockTransform.stop();
      workspace.setActiveCanvas(id);
    },
    zoomTo: (id) => {
      workspace.setActiveCanvas(id);
      zoomToCanvas(id);
    },
    drag: dragCanvas,
  });
  const blockTransform = new BlockTransformMode({
    workspace,
    getView: () => view,
    requestFrame: () => requestFrame(),
    modeChanged: () => refreshUi(),
  });
  const arrowControls = new ArrowControls({ workspace, getView: () => view, requestFrame: () => requestFrame() });
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
      if (liveStroke) project.scheduler.strokeStarted();
      project.noteActivity();
    },
    strokeMove(samples, predicted) {
      metrics.noteInput(samples, samples[samples.length - 1]?.timeStamp ?? performance.now());
      strokes.move(samples, predicted);
    },
    strokeEnd(cancelled) {
      // A cancelled stroke (e.g. the OS claimed the touch) is still kept: losing
      // what was drawn is worse than keeping it. The HUD counts cancellations.
      if (cancelled) metrics.counters.cancelledStrokes++;
      const drawing = liveStroke !== null;
      strokes.end();
      if (drawing) project.scheduler.strokeEnded();
    },
    strokeDiscard() {
      metrics.counters.cancelledStrokes++;
      strokes.discard();
      project.scheduler.strokeCancelled();
    },
    palmRejected() {
      metrics.counters.palmRejections++;
    },
    eyedropperActive: () => tools.current === 'eyedropper',
    eyedropper(phase, screen) {
      sampleColor(phase, screen);
      if (phase === 'end') tools.returnFromEyedropper();
    },
    // Strokes are off in block-transform mode: presses then pan, as on empty space.
    canDrawAt: (p) => !blockTransform.active && hitTest(workspace.canvases, p) !== null,
    emptySpacePress: (p) => arrowControls.pressAt(p),
    tap(fingers) {
      if (fingers === 2) undo();
      else redo();
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
  const perSecond = (v: number | null): string => (v === null ? '—' : v.toFixed(0));
  const ms = (v: number | null): string => (v === null ? '—' : v.toFixed(1));
  /** Phase 3: the active canvas's chain depth, and inheritors updated and stale in the last frame. */
  function inheritanceLine(): string {
    const id = workspace.activeCanvasId;
    const depth = id === null ? '—' : String(workspace.graph().depth(id));
    const last = metrics.frames.at(-1);
    return `inheritance    depth ${depth} · updated ${last?.inheritorsUpdated ?? '—'} · stale ${last?.staleInheritors ?? '—'}  (last frame)`;
  }

  const hud = new Hud(metrics, rendererLabel, () => {
    const s = workspace.stats();
    const a = active()?.stats();
    const m = renderer.memory();
    const r = metrics.residency();
    return [
      `canvases ${s.canvases} · active: ${a ? `${a.tileEntries} tiles in ${a.layers} layers` : 'none'}`,
      `tiles ${s.usedSlots} · on gpu ${m.residentTiles}/${m.tileCapacity} (${mb(m.residentTiles * TILE_BYTES)}) · compressed ${m.compressedTiles} (${mb(m.compressedBytes)})`,
      `visible canvases ${metrics.frames.at(-1)?.visibleCanvases ?? '—'}`,
      inheritanceLine(),
      `evictions ${perSecond(r.evictionsPerSecond)}/s · reloads ${perSecond(r.reloadsPerSecond)}/s (total ${m.evictions} / ${m.reloads})${m.loadingTiles ? ` · ${m.loadingTiles} loading` : ''}`,
      `reload ms ${ms(r.reloadMs.p50)} / ${ms(r.reloadMs.p95)}  (p50 / p95, last ${r.reloadMs.count})`,
      `gpu memory ≈ ${mb(m.bytes)} (layer pages ${m.layerPages}, composite pages ${m.compositePages})`,
      `undo memory ${mb(s.historyBytes)} (${s.historySteps} undo / ${s.redoSteps} redo, at raw tile size)`,
      `zoom ${Math.round(view.scale * 100)}%  dpr ${window.devicePixelRatio}  canvas ${canvas.width}×${canvas.height}`,
      `last touch ${input.lastTouchSizePx === null ? '—' : `${Math.round(input.lastTouchSizePx)} px`} (palm above ${GESTURES.palmContactPx})  finger draws: ${input.fingers.enabled ? 'yes' : 'no'}`,
      `coalesced ${inputCapabilities.coalescedEvents ? 'yes' : 'no'}  predicted ${inputCapabilities.predictedEvents ? 'yes' : 'no'}  ${isStandalone() ? 'home-screen app' : 'browser tab'}`,
    ];
  });

  const controls = new Controls(
    () => tools.editableSettings,
    () => (tools.paintingTool === 'eraser' ? 'Eraser' : 'Brush'),
    input.fingers,
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

  const selectTool = (tool: Tool): void => {
    blockTransform.stop(); // choosing a tool means "I want to draw again"
    tools.setTool(tool);
  };
  const picker = new ColorPicker((color) => tools.setColor(color));
  picker.setColor(tools.brush.color);
  const layersPanel = new LayersPanel(active, thumbnails, {
    goToCanvas: (id) => {
      blockTransform.stop();
      workspace.setActiveCanvas(id);
      zoomToCanvas(id);
    },
    transformBlock: (id) => blockTransform.toggle(id),
    isTransforming: (id) => blockTransform.canvasId === id,
  });
  thumbnails.onUpdated = () => layersPanel.update(); // the block row's thumbnail is built from layer thumbnails
  const canvasPanel = new CanvasPanel(() => workspace.canvases, () => workspace.activeCanvasId, {
    create: createCanvas,
    show: (id) => {
      workspace.setActiveCanvas(id);
      zoomToCanvas(id);
    },
    rename: (id, name) => workspace.renameCanvas(id, name),
    resize: resizeCanvas,
    duplicate: (id) => workspace.setActiveCanvas(workspace.duplicateCanvas(id).id),
    remove: (id) => workspace.deleteCanvas(id),
    bringToFront: (id) => workspace.bringToFront(id),
    fitAll: () => setView(fitAll()),
  });
  // The layers, canvases and history panels share the right-hand side: one at a time.
  const sidePanels = (): { visible: boolean; setVisible(v: boolean): void }[] => [layersPanel, canvasPanel, historyPanel, projectsPanel];
  function togglePanel(panel: { visible: boolean; setVisible(v: boolean): void }): void {
    const show = !panel.visible;
    for (const p of sidePanels()) p.setVisible(p === panel && show);
  }
  const historyPanel = new HistoryPanel({
    saveVersion: () => void saveVersion(),
    restore: (v) =>
      void project.restoreVersion(v).then((before) => {
        const kept = before ? `Your previous state is kept as “${before.name}”.` : 'Your previous state was already a version.';
        showBanner(`Restored “${v.name}”. ${kept} Undo history was cleared.`);
      }, reportVersionError),
    rename: (v, name) => void project.renameVersion(v.id, name).catch(reportVersionError),
    pin: (v, pinned) => void project.pinVersion(v.id, pinned).catch(reportVersionError),
    remove: (v) => void project.deleteVersion(v.id).then(() => showBanner(`Deleted “${v.name}”.`), reportVersionError),
    thumbnail: (v) => project.versionThumbnail(v),
  });
  project.onVersions = (versions) => historyPanel.setVersions(versions);
  historyPanel.setVersions(project.versions);
  async function saveVersion(): Promise<void> {
    try {
      const version = await project.saveVersion('manual');
      if (version) showBanner(`Saved version “${version.name}”.`);
    } catch (error) {
      reportVersionError(error);
    }
  }
  function reportVersionError(error: unknown): void {
    console.error(error);
    if (isQuotaError(error)) showQuotaWarning(QUOTA_MESSAGE);
    else showBanner(`Version history: ${error instanceof Error ? error.message : String(error)}`);
  }
  const projectsPanel = new ProjectsPanel({
    list: () => project.listProjects(),
    estimate: async () => {
      const e = await navigator.storage?.estimate?.();
      return e?.usage !== undefined && e.quota !== undefined ? { usage: e.usage, quota: e.quota } : null;
    },
    currentId: () => project.project?.id ?? null,
    currentReadOnly: () => project.readOnly,
    create: () => void switchProject(() => project.create('Untitled project').then(() => undefined)),
    open: (p) => void switchProject(() => project.open(p.id)),
    rename: (p, name) => void project.renameProject(p.id, name).then(() => projectsPanel.refresh(), reportProjectError),
    duplicate: (p) =>
      void project.duplicateProject(p.id, `${p.name} copy`).then((copy) => {
        showBanner(`Made “${copy.name}”.`);
        return projectsPanel.refresh();
      }, reportProjectError),
    remove: (p) =>
      void switchProject(async () => {
        const { reopened, view: saved } = await project.deleteProject(p.id);
        showBanner(`Deleted “${p.name}”.`);
        return reopened ? saved : null;
      }),
    storage: {
      persisted: async () => (navigator.storage?.persisted ? navigator.storage.persisted() : null),
      requestPersistence: async () => (navigator.storage?.persist ? navigator.storage.persist() : false),
      retention: () => project.retention,
      setRetention: (rules) => {
        saveRetention(rules);
        void project.setRetention(rules).catch(reportVersionError);
      },
      deleteAutomaticVersions: () => void deleteAutomaticVersions(),
      collectGarbage: () =>
        void project.collectGarbage().then((stats) => {
          showBanner(stats ? `Cleaned up ${formatBytes(stats.removedBytes)} in ${stats.removedFiles} files.` : 'Nothing to clean up right now.');
          return projectsPanel.refresh();
        }),
      notice: () => (inIosBrowserTab() ? SAFARI_TAB_NOTICE : null),
    },
  });
  /**
   * Run a project operation that may load another project, then show it:
   * the saved camera if it has one, else fit everything. `null` = the
   * workspace didn't change.
   */
  async function switchProject(task: () => Promise<ViewTransform | undefined | null>): Promise<void> {
    try {
      const saved = await task();
      if (saved !== null) {
        setView(saved ?? fitAll());
        historyPanel.setVersions(project.versions);
        refreshUi();
      }
      await projectsPanel.refresh();
    } catch (error) {
      reportProjectError(error);
    }
  }
  function reportProjectError(error: unknown): void {
    console.error(error);
    if (isQuotaError(error)) showQuotaWarning(QUOTA_MESSAGE);
    else showBanner(error instanceof Error ? error.message : String(error));
  }
  /** Storage is full: say so, and offer the two ways to make room. */
  function showQuotaWarning(message: string): void {
    showBanner(message, true, [
      { label: 'Delete automatic versions', run: () => void deleteAutomaticVersions() },
      { label: 'Projects…', run: () => togglePanel(projectsPanel) },
    ]);
  }
  async function deleteAutomaticVersions(): Promise<void> {
    try {
      const deleted = await project.deleteAutomaticVersions();
      showBanner(deleted > 0 ? `Deleted ${deleted} automatic version${deleted === 1 ? '' : 's'}.` : 'There were no automatic versions to delete.');
      await project.saveNow().catch(() => undefined); // try the save that failed again
      await projectsPanel.refresh();
    } catch (error) {
      reportProjectError(error);
    }
  }
  const toolbar = new Toolbar({
    selectTool,
    undo,
    redo,
    toggleColorPicker: () => picker.toggle(),
    toggleLayers: () => togglePanel(layersPanel),
    toggleFingerDrawing: () => {
      input.fingers.setting = input.fingers.enabled ? 'off' : 'on';
    },
    toggleArrows: () => {
      arrowControls.shown = !arrowControls.shown;
      if (!arrowControls.shown) arrowControls.select(null);
      refreshUi();
      requestFrame();
    },
    toggleCanvases: () => togglePanel(canvasPanel),
    toggleHistory: () => togglePanel(historyPanel),
    toggleProjects: () => togglePanel(projectsPanel),
  });

  function refreshUi(): void {
    toolbar.update({
      tool: tools.current,
      color: tools.brush.color,
      canUndo: workspace.history.canUndo,
      canRedo: workspace.history.canRedo,
      fingerDraws: input.fingers.enabled,
      showArrows: arrowControls.shown,
    });
    layersPanel.update();
    canvasPanel.update();
    picker.setRecentColors(tools.recentColors);
    controls.refresh();
  }
  tools.onChange(refreshUi);
  input.fingers.onChange(refreshUi);

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.hidden = true;
  let bannerTimer = 0;
  /** A message at the bottom; `actions` adds buttons (which also dismiss it). */
  function showBanner(message: string, sticky = false, actions: { label: string; run(): void }[] = []): void {
    banner.textContent = message;
    if (actions.length > 0) {
      const row = document.createElement('div');
      row.className = 'banner-actions';
      for (const action of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = action.label;
        b.addEventListener('click', () => {
          banner.hidden = true;
          action.run();
        });
        row.append(b);
      }
      row.append(Object.assign(document.createElement('button'), { type: 'button', textContent: 'Close', onclick: () => (banner.hidden = true) }));
      banner.append(row);
    }
    banner.hidden = false;
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = window.setTimeout(() => (banner.hidden = true), 5000);
  }
  renderer.onLost = (message) => showBanner(message, true);

  // --- saving (Phase 4) ---------------------------------------------------------

  const saveIndicator = new SaveIndicator((status) =>
    showBanner(status.message ?? (status.savedAt ? `All changes saved (last save ${new Date(status.savedAt).toLocaleTimeString()}).` : 'Not saved yet.')),
  );
  toolbar.element.append(saveIndicator.element);
  saveIndicator.update(project.status);
  project.onStatus = (status) => {
    saveIndicator.update(status);
    if (status.state === 'error' && status.message) {
      if (status.quota) showQuotaWarning(status.message);
      else showBanner(status.message);
    }
    if (status.state === 'read-only' && status.message) showBanner(status.message, true);
  };
  if (project.readOnly && project.status.message) showBanner(project.status.message, true);
  else if (inIosBrowserTab() && !sessionStorage.getItem('vc-tab-notice')) {
    sessionStorage.setItem('vc-tab-notice', '1'); // once per visit
    showBanner(SAFARI_TAB_NOTICE);
  }

  // Soft depth warning: whenever the deepest chain grows past the limit (by an arrow, the source
  // picker, or undo/redo), say so once. It never blocks.
  let deepestChain = workspace.graph().maxDepth();
  workspace.onChange(() => {
    const deepest = workspace.graph().maxDepth();
    const warning = depthWarning(deepestChain, deepest, INHERITANCE_DEPTH_WARNING);
    deepestChain = deepest;
    if (warning) showBanner(warning);
  });
  renderer.onNeedsFrame = requestFrame;

  // Development builds only: the workspace in the console, for trying things the UI can't do yet.
  if (import.meta.env.DEV) Object.assign(window, { workspace, metrics });

  if (new URLSearchParams(location.search).has('stress')) {
    controls.debugBody.append(
      createStressPanel({
        get editor() {
          return active() ?? workspace.editor(workspace.canvases[0]!.id);
        },
        workspace,
        strokes,
        tools,
        metrics,
        fitRect: (rect) => fitRectToView(rect, cssWidth, cssHeight),
        setView,
        report: (m) => showBanner(m, true),
        gpuBytes: () => renderer.memory().bytes,
      }),
    );
  }

  ui.append(undoIndicator.element, labels.element, arrowControls.element, blockTransform.element, toolbar.element, picker.element, controls.element, layersPanel.element, canvasPanel.element, historyPanel.element, projectsPanel.element, hud.element, loupe.element, banner, blockTransform.bar);
  refreshUi();

  installShortcuts({
    undo,
    redo,
    selectTool,
    resizeBrush: (factor) => tools.adjustSize(factor),
    newLayer: () => active()?.addLayer(),
    zoomBy: (factor) => setView(zoomAt(view, { x: cssWidth / 2, y: cssHeight / 2 }, factor)),
    zoomToActualSize: () => setView(zoomAt(view, { x: cssWidth / 2, y: cssHeight / 2 }, 1 / view.scale)), // 100% = one canvas pixel per CSS pixel, as in Figma and the HUD
    fitAll: () => setView(fitAll()),
    fitSelection: () => {
      const doc = active()?.doc;
      if (doc) setView(fitRectToView(doc.placement, cssWidth, cssHeight));
    },
    toggleHud: () => hud.setVisible(!hud.visible),
    saveVersion: () => void saveVersion(),
  });

  new ResizeObserver(resize).observe(canvas);
  watchDevicePixelRatio();
  resize();
  hud.setVisible(true); // after the first resize, so the HUD never shows the pre-fit view
}

/**
 * The canvases of a new project: one 4096² canvas, or with `?canvases=N` a
 * grid of N A4 canvases (for testing many canvases).
 */
const SAFARI_TAB_NOTICE =
  'You are using the app in a Safari tab. Safari may clear its saved projects after some days without a visit. Add it to the Home Screen (Share → Add to Home Screen) and use it from there to keep them.';

function seedCanvases(workspace: Workspace, count: number): PaintDocument[] {
  const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
  const size = n === 1 ? { width: 4096, height: 4096 } : { width: 2480, height: 3508 };
  const columns = Math.ceil(Math.sqrt(n));
  const gap = 300;
  const docs: PaintDocument[] = [];
  for (let i = 0; i < n; i++) {
    const doc = workspace.newCanvas(size, `Canvas ${i + 1}`);
    doc.x = (i % columns) * (size.width + gap);
    doc.y = Math.floor(i / columns) * (size.height + gap);
    docs.push(doc);
  }
  return docs;
}

main().catch((error: unknown) => {
  console.error(error);
  const message = document.createElement('pre');
  message.className = 'fatal';
  message.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
});

registerServiceWorker();
