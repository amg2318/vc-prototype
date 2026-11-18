import type { BlendMode } from '../document/blend';
import type { Editor } from '../document/editor';
import type { LayerId, RasterLayer } from '../document/paintDocument';
import { hexToRgb, rgbToHex } from './color';
import type { Thumbnails } from './thumbnails';

const BLEND_MODES: BlendMode[] = ['normal', 'multiply'];

/**
 * Layers panel. The list is shown top layer first (like every paint app),
 * while the document stores layers bottom first.
 *
 * Rows are rebuilt only when the list itself changes (order, names,
 * visibility, active layer). Property changes such as opacity update the
 * existing controls, so a slider being dragged is never replaced mid-drag.
 */
export class LayersPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly addButton: HTMLButtonElement;
  private readonly paperInput: HTMLInputElement;
  private signature = '';
  private opacitySlider: HTMLInputElement | null = null;
  private opacityOutput: HTMLOutputElement | null = null;
  private blendSelect: HTMLSelectElement | null = null;
  private opacityDrag = 0;

  constructor(
    private readonly editor: Editor,
    private readonly thumbnails: Thumbnails,
  ) {
    this.element = document.createElement('aside');
    this.element.className = 'layers panel';

    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = 'Layers';
    this.addButton = button('+', () => editor.addLayer(), 'Add layer (⇧N)');
    header.append(title, this.addButton);

    this.list = document.createElement('ol');

    const paperRow = document.createElement('label');
    paperRow.className = 'paper-row';
    this.paperInput = document.createElement('input');
    this.paperInput.type = 'color';
    this.paperInput.addEventListener('change', () => editor.setPaper(hexToRgb(this.paperInput.value)));
    paperRow.append(Object.assign(document.createElement('span'), { textContent: 'Background' }), this.paperInput);

    this.element.append(header, this.list, paperRow);
    this.update();
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  update(): void {
    const doc = this.editor.doc;
    const signature = JSON.stringify([
      this.editor.activeLayerId,
      doc.layers.map((l) => [l.id, l.name, l.visible]),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild();
    }
    const active = this.editor.activeLayer;
    if (this.opacitySlider && document.activeElement !== this.opacitySlider) {
      this.opacitySlider.value = String(active.opacity);
    }
    if (this.opacityOutput) this.opacityOutput.textContent = `${Math.round(active.opacity * 100)}%`;
    if (this.blendSelect) this.blendSelect.value = active.blendMode;
    this.addButton.disabled = !this.editor.canAddLayer;
    this.paperInput.value = rgbToHex(doc.paper);
  }

  private rebuild(): void {
    const layers = [...this.editor.doc.layers].reverse();
    this.opacitySlider = this.opacityOutput = this.blendSelect = null;
    this.list.replaceChildren(...layers.map((layer) => this.row(layer)));
  }

  private row(layer: RasterLayer): HTMLLIElement {
    const editor = this.editor;
    const isActive = layer.id === editor.activeLayerId;
    const li = document.createElement('li');
    li.className = 'layer-row';
    li.classList.toggle('active', isActive);
    li.classList.toggle('hidden-layer', !layer.visible);
    li.dataset.layerId = layer.id;

    const main = document.createElement('div');
    main.className = 'layer-main';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.addEventListener('dblclick', () => this.rename(layer.id));
    const eye = button(layer.visible ? '●' : '○', () => editor.setLayerProps(layer.id, { visible: !layer.visible }),
      layer.visible ? 'Hide layer' : 'Show layer');
    eye.classList.add('eye');
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '≡';
    handle.setAttribute('aria-label', 'Drag to reorder');
    this.makeDraggable(handle, li, layer.id);

    main.append(this.thumbnails.canvasFor(layer.id), name, eye, handle);
    main.addEventListener('click', (e) => {
      if (e.target === eye || e.target === handle) return;
      editor.setActiveLayer(layer.id);
    });
    li.append(main);
    if (isActive) li.append(this.details(layer));
    return li;
  }

  /** Controls for the active layer. */
  private details(layer: RasterLayer): HTMLElement {
    const editor = this.editor;
    const box = document.createElement('div');
    box.className = 'layer-details';

    const opacity = document.createElement('input');
    Object.assign(opacity, { type: 'range', min: '0', max: '1', step: '0.01', value: String(layer.opacity) });
    const output = document.createElement('output');
    // One slider drag = one undo step: all input events share a merge key until 'change'.
    opacity.addEventListener('input', () =>
      editor.setLayerProps(layer.id, { opacity: Number(opacity.value) }, `opacity-${layer.id}-${this.opacityDrag}`),
    );
    opacity.addEventListener('change', () => this.opacityDrag++);
    const opacityRow = document.createElement('label');
    opacityRow.className = 'row';
    opacityRow.append(Object.assign(document.createElement('span'), { textContent: 'Opacity' }), opacity, output);

    const blend = document.createElement('select');
    for (const mode of BLEND_MODES) blend.append(new Option(mode, mode, false, mode === layer.blendMode));
    blend.addEventListener('change', () => editor.setLayerProps(layer.id, { blendMode: blend.value as BlendMode }));
    const blendRow = document.createElement('label');
    blendRow.className = 'row';
    blendRow.append(Object.assign(document.createElement('span'), { textContent: 'Blend' }), blend);

    const actions = document.createElement('div');
    actions.className = 'buttons';
    actions.append(
      button('Rename', () => this.rename(layer.id), 'Rename layer'),
      button('Duplicate', () => editor.duplicateLayer(layer.id), 'Duplicate layer'),
      button('Clear', () => editor.clearLayer(layer.id), 'Clear layer'),
      button('Delete', () => editor.deleteLayer(layer.id), 'Delete layer'),
    );

    this.opacitySlider = opacity;
    this.opacityOutput = output;
    this.blendSelect = blend;
    box.append(opacityRow, blendRow, actions);
    return box;
  }

  private rename(id: LayerId): void {
    const name = prompt('Layer name', this.editor.doc.layer(id).name);
    if (name !== null) this.editor.renameLayer(id, name);
  }

  /** Drag a row by its handle; dropping moves the layer to the row it was dropped on. */
  private makeDraggable(handle: HTMLElement, row: HTMLElement, id: LayerId): void {
    let startY = 0;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      startY = e.clientY;
      row.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      row.style.transform = `translateY(${e.clientY - startY}px)`;
    });
    const finish = (e: PointerEvent): void => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      row.classList.remove('dragging');
      row.style.transform = '';
      // New list position = how many of the other rows are above the pointer.
      // The list shows the top layer first, so convert back to a document index.
      const others = ([...this.list.children] as HTMLElement[]).filter((r) => r !== row);
      const listIndex = others.filter((r) => {
        const rect = r.getBoundingClientRect();
        return rect.top + rect.height / 2 < e.clientY;
      }).length;
      this.editor.moveLayer(id, this.editor.doc.layers.length - 1 - listIndex);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }
}

function button(text: string, onClick: () => void, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}
