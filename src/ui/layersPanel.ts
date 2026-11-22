import type { BlendMode } from '../document/blend';
import type { Editor } from '../document/editor';
import type { LayerId, RasterLayer } from '../document/paintDocument';
import { hexToRgb, rgbToHex } from './color';
import { BlockSection, type BlockSectionActions } from './blockSection';
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
  private readonly paperEye: HTMLButtonElement;
  private signature = '';
  private opacitySlider: HTMLInputElement | null = null;
  private opacityOutput: HTMLOutputElement | null = null;
  private blendSelect: HTMLSelectElement | null = null;
  private opacityDrag = 0;
  /** The inherited block's row, always last in the list (the block is drawn below every layer). */
  private readonly block: BlockSection;

  /** The canvas being edited; set by `update()`. */
  private editor: Editor | null = null;

  /** `activeEditor` gives the active canvas's editor (null when no canvas is selected). */
  constructor(
    private readonly activeEditor: () => Editor | null,
    private readonly thumbnails: Thumbnails,
    blockActions: BlockSectionActions,
  ) {
    this.block = new BlockSection(thumbnails, blockActions);
    this.element = document.createElement('aside');
    this.element.className = 'layers panel';

    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = 'Layers';
    this.addButton = button('+', () => this.editor?.addLayer(), 'Add layer (⇧N)');
    header.append(title, this.addButton);

    this.list = document.createElement('ol');

    const paperRow = document.createElement('div');
    paperRow.className = 'paper-row';
    this.paperInput = document.createElement('input');
    this.paperInput.type = 'color';
    this.paperInput.setAttribute('aria-label', 'Background colour');
    this.paperInput.addEventListener('change', () => this.editor?.setPaper(hexToRgb(this.paperInput.value)));
    // Hidden background: the canvas is transparent, and canvases inheriting it see only the strokes.
    this.paperEye = button('●', () => {
      if (this.editor) this.editor.setPaperVisible(!this.editor.doc.paperVisible);
    }, 'Hide background');
    this.paperEye.classList.add('eye');
    paperRow.append(Object.assign(document.createElement('span'), { textContent: 'Background' }), this.paperInput, this.paperEye);

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
    const editor = this.activeEditor();
    this.editor = editor;
    this.element.classList.toggle('no-canvas', editor === null);
    if (!editor) {
      this.signature = '';
      this.list.replaceChildren();
      this.addButton.disabled = true;
      return;
    }
    const doc = editor.doc;
    const signature = JSON.stringify([
      doc.id,
      editor.activeLayerId,
      doc.layers.map((l) => [l.id, l.name, l.visible]),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild();
    }
    if (this.list.lastElementChild !== this.block.element) this.list.append(this.block.element);
    this.block.update(editor);
    const active = editor.activeLayer;
    if (this.opacitySlider && document.activeElement !== this.opacitySlider) {
      this.opacitySlider.value = String(active.opacity);
    }
    if (this.opacityOutput) this.opacityOutput.textContent = `${Math.round(active.opacity * 100)}%`;
    if (this.blendSelect) this.blendSelect.value = active.blendMode;
    this.addButton.disabled = !editor.canAddLayer;
    this.paperInput.value = rgbToHex(doc.paper);
    this.paperEye.textContent = doc.paperVisible ? '●' : '○';
    this.paperEye.title = doc.paperVisible ? 'Hide background' : 'Show background';
    this.paperEye.setAttribute('aria-label', this.paperEye.title);
    this.paperInput.disabled = !doc.paperVisible;
  }

  private rebuild(): void {
    const layers = [...this.editor!.doc.layers].reverse();
    this.opacitySlider = this.opacityOutput = this.blendSelect = null;
    this.list.replaceChildren(...layers.map((layer) => this.row(layer)));
  }

  private row(layer: RasterLayer): HTMLLIElement {
    const editor = this.editor!;
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
    const editor = this.editor!;
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
    const editor = this.editor;
    if (!editor) return;
    const name = prompt('Layer name', editor.doc.layer(id).name);
    if (name !== null) editor.renameLayer(id, name);
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
      this.editor?.moveLayer(id, this.editor.doc.layers.length - 1 - listIndex);
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
