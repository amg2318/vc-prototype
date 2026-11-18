import type { PaintDocument } from '../document/paintDocument';
import { docToScreen, screenToDoc, type Vec2, type ViewTransform } from '../viewport/viewport';

export interface CanvasLabelActions {
  /** A tap on a label. */
  select(canvasId: string): void;
  /** A double tap on a label. */
  zoomTo(canvasId: string): void;
  /**
   * A label is being dragged. `dx`, `dy`: total movement in workspace px since
   * the drag began. `phase` 'end' comes once, after the last move.
   */
  drag(canvasId: string, dx: number, dy: number, phase: 'start' | 'move' | 'end'): void;
}

/** Movement (CSS px) before a press on a label counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 4;
const DOUBLE_TAP_MS = 350;

/**
 * Canvas names drawn just above each canvas's top-left corner. They are DOM
 * elements, so they keep the same size at every zoom level. Labels of
 * canvases far off screen are hidden.
 *
 * Tapping a label selects its canvas, double-tapping zooms to it, and
 * dragging it moves the canvas. (Inside a canvas the pen always draws, so
 * the label is the handle for moving it.)
 */
export class CanvasLabels {
  readonly element = document.createElement('div');
  private readonly labels = new Map<string, HTMLDivElement>();
  private press: { canvasId: string; pointerId: number; start: Vec2; dragging: boolean } | null = null;
  private lastTap = { canvasId: '', time: 0 };

  constructor(
    private readonly getView: () => ViewTransform,
    private readonly actions: CanvasLabelActions,
  ) {
    this.element.className = 'canvas-labels';
  }

  update(canvases: readonly PaintDocument[], activeId: string | null, view: ViewTransform, cssWidth: number, cssHeight: number): void {
    const seen = new Set<string>();
    for (const doc of canvases) {
      seen.add(doc.id);
      const label = this.labels.get(doc.id) ?? this.createLabel(doc.id);
      if (label.textContent !== doc.name) label.textContent = doc.name;
      label.classList.toggle('active', doc.id === activeId);
      const p = docToScreen(view, { x: doc.x, y: doc.y });
      const onScreen = p.x > -400 && p.y > -50 && p.x < cssWidth + 50 && p.y < cssHeight + 50;
      label.hidden = !onScreen && this.press?.canvasId !== doc.id;
      if (!label.hidden) label.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }
    for (const [id, label] of this.labels) {
      if (seen.has(id)) continue;
      label.remove();
      this.labels.delete(id);
    }
  }

  private createLabel(canvasId: string): HTMLDivElement {
    const label = document.createElement('div');
    label.className = 'canvas-label';
    label.addEventListener('pointerdown', (e) => {
      if (this.press || e.button !== 0) return;
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      this.press = { canvasId, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, dragging: false };
    });
    label.addEventListener('pointermove', (e) => {
      const press = this.press;
      if (!press || press.pointerId !== e.pointerId) return;
      const now = { x: e.clientX, y: e.clientY };
      if (!press.dragging) {
        if (Math.hypot(now.x - press.start.x, now.y - press.start.y) < DRAG_THRESHOLD_PX) return;
        press.dragging = true;
        this.actions.drag(canvasId, 0, 0, 'start');
      }
      // Convert the screen movement to workspace px (the view may be zoomed or rotated).
      const view = this.getView();
      const a = screenToDoc(view, press.start);
      const b = screenToDoc(view, now);
      this.actions.drag(canvasId, b.x - a.x, b.y - a.y, 'move');
    });
    const finish = (e: PointerEvent, cancelled: boolean): void => {
      const press = this.press;
      if (!press || press.pointerId !== e.pointerId) return;
      this.press = null;
      if (press.dragging) {
        this.actions.drag(canvasId, 0, 0, 'end');
        return;
      }
      if (cancelled) return;
      const isDoubleTap = this.lastTap.canvasId === canvasId && e.timeStamp - this.lastTap.time < DOUBLE_TAP_MS;
      this.lastTap = { canvasId, time: isDoubleTap ? 0 : e.timeStamp };
      if (isDoubleTap) this.actions.zoomTo(canvasId);
      else this.actions.select(canvasId);
    };
    label.addEventListener('pointerup', (e) => finish(e, false));
    label.addEventListener('pointercancel', (e) => finish(e, true));
    this.labels.set(canvasId, label);
    this.element.append(label);
    return label;
  }
}
