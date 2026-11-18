import type { PaintDocument } from '../document/paintDocument';
import { docToScreen, type ViewTransform } from '../viewport/viewport';

/**
 * Canvas names drawn just above each canvas's top-left corner. They are DOM
 * elements, so they keep the same size at every zoom level. Labels of
 * canvases far off screen are hidden.
 */
export class CanvasLabels {
  readonly element = document.createElement('div');
  private readonly labels = new Map<string, HTMLDivElement>();

  constructor() {
    this.element.className = 'canvas-labels';
  }

  update(canvases: readonly PaintDocument[], activeId: string | null, view: ViewTransform, cssWidth: number, cssHeight: number): void {
    const seen = new Set<string>();
    for (const doc of canvases) {
      seen.add(doc.id);
      let label = this.labels.get(doc.id);
      if (!label) {
        label = document.createElement('div');
        label.className = 'canvas-label';
        this.labels.set(doc.id, label);
        this.element.append(label);
      }
      if (label.textContent !== doc.name) label.textContent = doc.name;
      label.classList.toggle('active', doc.id === activeId);
      const p = docToScreen(view, { x: doc.x, y: doc.y });
      const onScreen = p.x > -400 && p.y > -50 && p.x < cssWidth + 50 && p.y < cssHeight + 50;
      label.hidden = !onScreen;
      if (onScreen) label.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }
    for (const [id, label] of this.labels) {
      if (seen.has(id)) continue;
      label.remove();
      this.labels.delete(id);
    }
  }
}
