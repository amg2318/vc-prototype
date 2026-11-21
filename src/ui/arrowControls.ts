import type { CanvasId } from '../document/paintDocument';
import type { OverlayShape } from '../render/renderer';
import { containsPoint, hitTest, type Rect } from '../workspace/coords';
import type { Workspace } from '../workspace/workspace';
import { docToScreen, screenToDoc, type Vec2, type ViewTransform } from '../viewport/viewport';
import { arrowEmphasis, arrowLines, arrowQuads, edgeToEdge, hitArrow, type ArrowLine } from './arrows';
import { selectionOutline } from './selectionOutline';

/**
 * What a connection gesture is choosing:
 *  - 'create': the canvas that will inherit `sourceId` (from a canvas's connection handle);
 *  - 'source': a new source for `inheritorId` (arrow tail, "Change source", relinking a stub);
 *  - 'head':   a new inheritor for the arrow into `inheritorId` (arrow head).
 */
export type Connection =
  | { kind: 'create'; sourceId: CanvasId }
  | { kind: 'source'; inheritorId: CanvasId }
  | { kind: 'head'; inheritorId: CanvasId };

/** Can `canvasId` complete this connection? (Pure, so it is unit-tested.) */
export function isValidTarget(ws: Workspace, c: Connection, canvasId: CanvasId): boolean {
  switch (c.kind) {
    case 'create':
      return canvasId !== c.sourceId && ws.canConnect(canvasId, c.sourceId);
    case 'source':
      return ws.canConnect(c.inheritorId, canvasId);
    case 'head': {
      const source = ws.graph().sourceOf(c.inheritorId);
      return source !== null && canvasId !== c.inheritorId && ws.canConnect(canvasId, source);
    }
  }
}

/** Complete a connection on `canvasId` (one undo step). Returns the arrow (inheritor id) it made or changed. */
export function completeConnection(ws: Workspace, c: Connection, canvasId: CanvasId): CanvasId | null {
  if (!isValidTarget(ws, c, canvasId)) return null;
  switch (c.kind) {
    case 'create':
      return ws.connect(canvasId, c.sourceId) ? canvasId : null;
    case 'source':
      return ws.connect(c.inheritorId, canvasId) ? c.inheritorId : null;
    case 'head':
      return ws.moveArrowHead(c.inheritorId, canvasId) ? canvasId : null;
  }
}

export interface ArrowControlsHost {
  workspace: Workspace;
  getView(): ViewTransform;
  requestFrame(): void;
}

/** Touch targets: at least 44 pt (CSS px). */
const TARGET_PX = 44;
/** Movement (CSS px) before a press on a handle counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 4;
const DIM: [number, number, number, number] = [0, 0, 0, 0.55]; // premultiplied black
const VALID = { devicePx: 2, color: [0.3, 0.85, 0.45, 1] as [number, number, number, number] };
const HOVERED = { devicePx: 6, color: VALID.color };

/**
 * Creating, selecting, retargeting and deleting arrows, with pen, finger or
 * mouse. Arrows themselves are drawn by the GPU overlay pass; the controls
 * here are DOM elements (like the canvas labels), so they keep the same
 * size at any zoom and pointer capture works the same for every input.
 *
 *  - Each canvas has a connection handle at its top-right corner, on the
 *    row of its name label. Drag it onto another canvas to make that canvas
 *    inherit this one, or tap it and then tap the canvas.
 *  - Tap an arrow (between canvases) to select it. A selected arrow shows
 *    grips at both ends: drag the tail onto another canvas to change the
 *    source, or the head to move the arrow to another inheritor. Tapping a
 *    grip and then a canvas does the same. Its action bar has "Change
 *    source" and "Delete arrow" (also the Delete key).
 *  - Tapping a broken stub (the source was deleted) starts relinking: tap
 *    the canvas to inherit from.
 * While choosing, canvases that can't be chosen (they would make a cycle)
 * are dimmed and valid ones are outlined.
 */
export class ArrowControls {
  readonly element = document.createElement('div');
  /** Global "show arrows" toggle. */
  shown = true;
  /** The selected arrow, by its inheritor (null: none). */
  selected: CanvasId | null = null;

  private readonly handles = new Map<CanvasId, HTMLButtonElement>();
  private readonly tailGrip = grip('Drag to another canvas to change the source');
  private readonly headGrip = grip('Drag to another canvas to move the arrow');
  private readonly bar = document.createElement('div');
  private readonly picker = document.createElement('div');
  private readonly pickerHint = document.createElement('div');

  /** The connection being made: dragged (pointer held) or picked (tap, then tap a canvas). */
  private active: { connection: Connection; pointerId: number | null; start: Vec2; dragging: boolean } | null = null;
  /** Pointer position in workspace px while choosing (null: not over the workspace yet). */
  private pointer: Vec2 | null = null;
  private lines: ArrowLine[] = [];

  constructor(private readonly host: ArrowControlsHost) {
    this.element.className = 'arrow-controls';
    this.bar.className = 'arrow-bar panel';
    this.picker.className = 'arrow-picker';
    this.pickerHint.className = 'arrow-picker-hint panel';
    this.picker.append(this.pickerHint);
    this.picker.hidden = true;
    this.element.append(this.tailGrip, this.headGrip, this.bar, this.picker);

    this.listenForConnection(this.tailGrip, () => (this.selected === null ? null : { kind: 'source', inheritorId: this.selected }));
    this.listenForConnection(this.headGrip, () => (this.selected === null ? null : { kind: 'head', inheritorId: this.selected }));
    this.listenForPicking();
    window.addEventListener('keydown', this.onKeyDown);
  }

  private get ws(): Workspace {
    return this.host.workspace;
  }

  // --- queries used by the app -----------------------------------------------

  /** Arrows, plus (while choosing) dimmed and outlined canvases and a rubber-band arrow. */
  overlay(selectedCanvas: CanvasId | null, canvasPxPerDevicePx: number): OverlayShape[] {
    if (!this.shown) return [];
    this.lines = arrowLines(this.ws.canvases, canvasPxPerDevicePx);
    const emphasis = arrowEmphasis(this.lines, this.ws.graph(), selectedCanvas, this.selected);
    const shapes: OverlayShape[] = arrowQuads(this.lines, emphasis, canvasPxPerDevicePx);
    if (!this.active) return shapes;

    const c = this.active.connection;
    const hovered = this.pointer ? hitTest(this.ws.canvases, this.pointer) : null;
    for (const doc of this.ws.canvases) {
      if (isFixedEnd(c, doc.id)) continue;
      if (!isValidTarget(this.ws, c, doc.id)) shapes.push({ rect: doc.placement, color: DIM });
      else shapes.push(...selectionOutline(doc.placement, canvasPxPerDevicePx, doc === hovered ? HOVERED : VALID));
    }
    const band = this.rubberBand(c, canvasPxPerDevicePx);
    if (band) shapes.push(...arrowQuads([band], new Map([[band.inheritorId, 'full']]), canvasPxPerDevicePx));
    return shapes;
  }

  /** A press on empty space: select the arrow under it (a stub starts relinking), or deselect. */
  pressAt(p: Vec2): void {
    if (!this.shown || this.active) return;
    const hit = hitArrow(this.lines, p, TARGET_PX / 2 / this.host.getView().scale);
    this.select(hit?.inheritorId ?? null);
    if (hit?.kind === 'missing') this.startPicking({ kind: 'source', inheritorId: hit.inheritorId });
  }

  select(inheritorId: CanvasId | null): void {
    if (this.selected === inheritorId) return;
    this.selected = inheritorId;
    this.host.requestFrame();
  }

  /** Reposition the DOM controls; call once per frame, after the view changed. */
  update(view: ViewTransform, cssWidth: number, cssHeight: number): void {
    this.element.hidden = !this.shown;
    if (this.selected !== null && !this.lines.some((l) => l.inheritorId === this.selected)) this.selected = null;
    this.updateHandles(view, cssWidth, cssHeight);
    this.updateSelection(view);
    this.updatePicker();
  }

  // --- connection handles ----------------------------------------------------

  private updateHandles(view: ViewTransform, cssWidth: number, cssHeight: number): void {
    const seen = new Set<CanvasId>();
    for (const doc of this.ws.canvases) {
      seen.add(doc.id);
      const handle = this.handles.get(doc.id) ?? this.createHandle(doc.id);
      // Top-right corner, just above the canvas (the name label is at the top left).
      const p = docToScreen(view, { x: doc.x + doc.width, y: doc.y });
      const onScreen = p.x > -TARGET_PX && p.y > -TARGET_PX && p.x < cssWidth + TARGET_PX && p.y < cssHeight + TARGET_PX;
      handle.hidden = !onScreen;
      handle.classList.toggle('active', this.active?.connection.kind === 'create' && this.active.connection.sourceId === doc.id);
      if (onScreen) place(handle, { x: p.x - TARGET_PX / 2, y: p.y - TARGET_PX / 2 - 2 });
    }
    for (const [id, handle] of this.handles) {
      if (seen.has(id)) continue;
      handle.remove();
      this.handles.delete(id);
    }
  }

  private createHandle(canvasId: CanvasId): HTMLButtonElement {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'connect-handle';
    handle.title = 'Drag onto a canvas to make it inherit this one (or tap, then tap the canvas)';
    handle.setAttribute('aria-label', 'Connect: inherit this canvas');
    this.listenForConnection(handle, () => ({ kind: 'create', sourceId: canvasId }));
    this.handles.set(canvasId, handle);
    this.element.append(handle);
    return handle;
  }

  // --- selected arrow: end grips and action bar ---------------------------------

  private updateSelection(view: ViewTransform): void {
    const line = this.lines.find((l) => l.inheritorId === this.selected) ?? null;
    const choosing = this.active !== null;
    this.tailGrip.hidden = !line || choosing;
    this.headGrip.hidden = !line || line.kind !== 'linked' || choosing;
    this.bar.hidden = !line || choosing;
    if (!line) return;

    const from = docToScreen(view, line.from);
    const to = docToScreen(view, line.to);
    place(this.tailGrip, { x: from.x - TARGET_PX / 2, y: from.y - TARGET_PX / 2 });
    place(this.headGrip, { x: to.x - TARGET_PX / 2, y: to.y - TARGET_PX / 2 });
    place(this.bar, { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + TARGET_PX / 2 });

    const key = `${line.inheritorId}:${line.kind}`;
    if (this.bar.dataset.key === key) return;
    this.bar.dataset.key = key;
    const inheritorId = line.inheritorId;
    const changeSource = (): void => this.startPicking({ kind: 'source', inheritorId });
    this.bar.replaceChildren(
      button(line.kind === 'missing' ? 'Relink…' : 'Change source…', changeSource),
      button('Delete arrow', () => this.deleteSelected()),
    );
  }

  private deleteSelected(): void {
    if (this.selected === null) return;
    this.ws.deleteArrow(this.selected);
    this.select(null);
  }

  // --- choosing a canvas: drag, or tap then tap ---------------------------------

  /** Press on `el` and drag onto a canvas, or tap it and then tap a canvas. */
  private listenForConnection(el: HTMLElement, connection: () => Connection | null): void {
    el.addEventListener('pointerdown', (e) => {
      const c = connection();
      if (this.active || !c || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      this.active = { connection: c, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, dragging: false };
      this.pointer = null;
      this.host.requestFrame();
    });
    el.addEventListener('pointermove', (e) => {
      const a = this.active;
      if (!a || a.pointerId !== e.pointerId) return;
      if (!a.dragging && Math.hypot(e.clientX - a.start.x, e.clientY - a.start.y) < DRAG_THRESHOLD_PX) return;
      a.dragging = true;
      this.pointer = this.toWorkspace(e);
      this.host.requestFrame();
    });
    const release = (e: PointerEvent, cancelled: boolean): void => {
      const a = this.active;
      if (!a || a.pointerId !== e.pointerId) return;
      if (a.dragging) {
        if (!cancelled) this.completeAt(this.toWorkspace(e));
        this.finish();
      } else if (cancelled) {
        this.finish();
      } else {
        a.pointerId = null; // a tap: keep choosing, by tapping a canvas
      }
      this.host.requestFrame();
    };
    el.addEventListener('pointerup', (e) => release(e, false));
    el.addEventListener('pointercancel', (e) => release(e, true));
  }

  private startPicking(connection: Connection): void {
    this.active = { connection, pointerId: null, start: { x: 0, y: 0 }, dragging: false };
    this.pointer = null;
    this.host.requestFrame();
  }

  /**
   * While picking, a full-screen layer catches the next tap: on a valid
   * canvas it completes the connection; anywhere else it cancels.
   */
  private listenForPicking(): void {
    this.picker.addEventListener('pointermove', (e) => {
      if (this.active?.pointerId !== null) return;
      this.pointer = this.toWorkspace(e);
      this.host.requestFrame();
    });
    this.picker.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.target !== this.picker) return; // the hint's Cancel button
      this.pointer = this.toWorkspace(e);
      this.completeAt(this.pointer);
      this.finish();
    });
  }

  private updatePicker(): void {
    const picking = this.active !== null && this.active.pointerId === null;
    this.picker.hidden = !picking;
    if (!picking) return;
    const text = this.active!.connection.kind === 'create' ? 'Tap the canvas that should inherit this one' : this.active!.connection.kind === 'source' ? 'Tap the canvas to inherit from' : 'Tap the canvas to move the arrow to';
    if (this.pickerHint.dataset.text === text) return;
    this.pickerHint.dataset.text = text;
    this.pickerHint.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }), button('Cancel', () => this.finish()));
  }

  private completeAt(p: Vec2): void {
    const target = hitTest(this.ws.canvases, p);
    if (!target || !this.active) return;
    const arrow = completeConnection(this.ws, this.active.connection, target.id);
    if (arrow !== null && this.active.connection.kind !== 'create') this.selected = arrow;
  }

  private finish(): void {
    this.active = null;
    this.pointer = null;
    this.host.requestFrame();
  }

  /** The arrow being drawn while choosing: from the fixed end to the pointer. */
  private rubberBand(c: Connection, canvasPxPerDevicePx: number): ArrowLine | null {
    if (!this.pointer) return null;
    const point: Rect = { ...this.pointer, width: 0, height: 0 };
    const gap = 8 * canvasPxPerDevicePx;
    let line: { from: Vec2; to: Vec2 } | null = null;
    if (c.kind === 'source') {
      line = edgeToEdge(point, this.ws.canvas(c.inheritorId).placement, gap);
    } else {
      const sourceId = c.kind === 'create' ? c.sourceId : this.ws.graph().sourceOf(c.inheritorId);
      if (sourceId !== null && !containsPoint(this.ws.canvas(sourceId).placement, this.pointer)) {
        line = edgeToEdge(this.ws.canvas(sourceId).placement, point, gap);
      }
    }
    return line && { inheritorId: '(dragging)', kind: 'linked', ...line };
  }

  private toWorkspace(e: PointerEvent): Vec2 {
    return screenToDoc(this.host.getView(), { x: e.clientX, y: e.clientY });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    if (e.key === 'Escape' && (this.active || this.selected !== null)) {
      if (this.active) this.finish();
      else this.select(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null && !this.active) {
      e.preventDefault();
      this.deleteSelected();
    }
  };
}

/** The canvas a connection starts from (not a target). */
function isFixedEnd(c: Connection, id: CanvasId): boolean {
  return c.kind === 'create' ? c.sourceId === id : c.inheritorId === id;
}

function place(el: HTMLElement, p: Vec2): void {
  el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
}

function grip(title: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'arrow-grip';
  el.title = title;
  el.setAttribute('aria-label', title);
  el.hidden = true;
  return el;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function isTyping(target: EventTarget | null): boolean {
  return (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number')) || target instanceof HTMLTextAreaElement;
}
