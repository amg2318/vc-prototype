import { THUMBNAIL_SIZE } from '../config';
import type { Editor } from '../document/editor';
import type { BlockBlendMode, Effect, InheritedBlock } from '../document/inheritedBlock';
import type { CanvasId, PaintDocument } from '../document/paintDocument';
import type { Workspace } from '../workspace/workspace';
import type { BlockTool } from './blockTransformMode';
import type { Thumbnails } from './thumbnails';

const BLOCK_BLEND_MODES: BlockBlendMode[] = ['normal', 'multiply', 'screen', 'overlay'];
const DEFAULT_POSTERIZE_LEVELS = 4;

export interface BlockSectionActions {
  /** Select a canvas and bring it into view ("Go to source"). */
  goToCanvas(id: CanvasId): void;
  /** Edit this canvas's block on the canvas with `tool` (or stop, if that tool is already on). */
  editBlock(id: CanvasId, tool: BlockTool): void;
  /** The on-canvas tool in use for this canvas's block, or null. */
  blockTool(id: CanvasId): BlockTool | null;
}

/**
 * The inherited block in the layers panel: a row at the bottom of the layer
 * list (below every layer, where the block is drawn) and, when the row is
 * open, the block's properties.
 *
 * Like the layer rows, the controls are rebuilt only when the structure
 * changes (source, state, which effects are on, the list of canvases);
 * values such as opacity and placement update the existing controls, so a
 * slider or field being used is never replaced.
 */
export class BlockSection {
  readonly element = document.createElement('li');
  private open = false;
  private signature = '';
  private editor: Editor | null = null;
  /** Value controls updated in place: key → control. */
  private fields = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private summary: HTMLElement | null = null;
  private thumbnail = document.createElement('canvas');
  private opacityDrag = 0;

  constructor(
    private readonly thumbnails: Thumbnails,
    private readonly actions: BlockSectionActions,
  ) {
    this.element.className = 'layer-row block-row';
    this.thumbnail.width = this.thumbnail.height = THUMBNAIL_SIZE;
    this.thumbnail.className = 'thumbnail';
  }

  update(editor: Editor): void {
    this.editor = editor;
    const doc = editor.doc;
    const block = doc.inherited;
    const ws = editor.workspace;
    const signature = JSON.stringify([
      doc.id,
      this.open,
      block?.source,
      block?.visible,
      block?.effects.map((e) => e.kind),
      block?.placement.mode,
      block?.placement.flipX,
      block?.placement.flipY,
      block?.crop !== undefined,
      ws.canvases.map((c) => [c.id, c.name]),
      block ? null : ws.graph().downstream(doc.id), // which canvases "Inherit from" offers
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(editor);
    }
    if (block) this.refreshValues(block, ws);
    this.drawThumbnail(ws, block);
  }

  // --- building ------------------------------------------------------------------

  private rebuild(editor: Editor): void {
    this.fields.clear();
    const block = editor.doc.inherited;
    this.element.classList.toggle('active', this.open && block !== null);
    this.element.classList.toggle('hidden-layer', block !== null && !block.visible);
    if (!block) {
      this.element.replaceChildren(this.inheritFromRow(editor));
      return;
    }
    const main = document.createElement('div');
    main.className = 'layer-main';
    const text = document.createElement('div');
    text.className = 'layer-name';
    const title = document.createElement('div');
    title.textContent = 'Inherited block';
    this.summary = document.createElement('div');
    this.summary.className = 'block-summary';
    text.append(title, this.summary);
    const eye = button(block.visible ? '●' : '○', () => this.set({ visible: !(editor.doc.inherited?.visible ?? true) }), block.visible ? 'Hide block' : 'Show block');
    eye.classList.add('eye');
    main.append(this.thumbnail, text, eye);
    main.addEventListener('click', (e) => {
      if (e.target === eye) return;
      this.open = !this.open;
      this.signature = '';
      this.update(editor);
    });
    this.element.replaceChildren(main);
    if (this.open) this.element.append(this.properties(editor, block));
  }

  /** No block yet: offer a source (the same as drawing an arrow). */
  private inheritFromRow(editor: Editor): HTMLElement {
    const row = document.createElement('label');
    row.className = 'row block-inherit';
    const select = this.sourceSelect(editor, null, 'Inherit from…');
    row.append(span('No inherited block'), select);
    return row;
  }

  private properties(editor: Editor, block: InheritedBlock): HTMLElement {
    const box = document.createElement('div');
    box.className = 'layer-details block-details';
    const id = editor.doc.id;
    const ws = editor.workspace;
    const source = block.source.kind === 'linked' ? block.source.canvasId : null;
    /** The block as it is now (handlers run later, after other edits). */
    const live = (): InheritedBlock => editor.doc.inherited ?? block;

    // Source
    const sourceRow = document.createElement('label');
    sourceRow.className = 'row';
    const goTo = button('Go to', () => source && this.actions.goToCanvas(source), 'Go to source');
    goTo.disabled = source === null;
    sourceRow.append(span('Source'), this.sourceSelect(editor, source, block.source.kind === 'missing' ? 'Source deleted — relink…' : 'Choose…'), goTo);

    // Opacity and blend (one slider drag = one undo step)
    const opacity = this.input('opacity', 'range', { min: '0', max: '1', step: '0.01' });
    opacity.addEventListener('input', () => this.set({ opacity: Number(opacity.value) }, `block-opacity-${id}-${this.opacityDrag}`));
    opacity.addEventListener('change', () => this.opacityDrag++);
    const opacityOut = document.createElement('output');
    opacityOut.dataset.field = 'opacityText';
    const blend = document.createElement('select');
    for (const mode of BLOCK_BLEND_MODES) blend.append(new Option(mode, mode));
    blend.addEventListener('change', () => this.set({ blendMode: blend.value as BlockBlendMode }));
    this.fields.set('blendMode', blend);

    // Placement: centre (canvas px), scale (%), rotation (°), flips
    const place = (changes: Parameters<Workspace['placeBlock']>[1]): void => ws.placeBlock(id, changes);
    const x = this.numberField('x', (v) => place({ x: v }));
    const y = this.numberField('y', (v) => place({ y: v }));
    const scale = this.numberField('scale', (v) => v > 0 && place({ scale: v / 100 }));
    const rotation = this.numberField('rotation', (v) => place({ rotation: (v * Math.PI) / 180 }));
    const flipX = button('Flip H', () => place({ flipX: !live().placement.flipX }), 'Flip horizontally');
    const flipY = button('Flip V', () => place({ flipY: !live().placement.flipY }), 'Flip vertically');
    flipX.classList.toggle('active', block.placement.flipX);
    flipY.classList.toggle('active', block.placement.flipY);
    const refit = button('Refit', () => ws.refitBlock(id), 'Fit the block inside the canvas again');
    const placement = grid([
      [span('Position'), x, y],
      [span('Scale %'), scale, span('')],
      [span('Rotate °'), rotation, span('')],
    ]);
    const transform = button('Transform', () => this.actions.editBlock(id, 'transform'), 'Move, scale and rotate the block on the canvas (tap again to finish)');
    transform.dataset.field = 'transform';
    const placementButtons = buttons(transform, flipX, flipY, refit);
    const mode = span(block.placement.mode === 'fit' ? 'Placement: fit inside' : 'Placement: custom');
    mode.className = 'block-mode';

    // Crop: on the canvas, by dragging the block's edges
    const crop = button('Crop', () => this.actions.editBlock(id, 'crop'), 'Crop the block on the canvas by dragging its edges (tap again to finish)');
    crop.dataset.field = 'crop';
    const resetCrop = button('Reset crop', () => ws.setBlock(id, { crop: undefined }, 'Crop inherited block'), 'Show the whole source');
    resetCrop.disabled = block.crop === undefined;

    // Effects, applied in this order
    const effectsBox = document.createElement('div');
    effectsBox.className = 'buttons';
    const has = (kind: Effect['kind']): Effect | undefined => live().effects.find((e) => e.kind === kind);
    const setEffects = (next: Effect[]): void => this.set({ effects: next }, null, 'Inherited block effects');
    const toggle = (kind: Effect['kind'], label: string): HTMLButtonElement => {
      const on = has(kind) !== undefined;
      const b = button(label, () => {
        const on = has(kind) !== undefined;
        const effects = ['grayscale', 'invert', 'posterize'].flatMap((k): Effect[] => {
          const existing = has(k as Effect['kind']);
          const wanted = k === kind ? !on : existing !== undefined;
          if (!wanted) return [];
          if (existing) return [existing];
          return [k === 'posterize' ? { kind: 'posterize', levels: DEFAULT_POSTERIZE_LEVELS } : { kind: k as 'grayscale' | 'invert' }];
        });
        setEffects(effects);
      }, on ? `Turn ${label.toLowerCase()} off` : `Turn ${label.toLowerCase()} on`);
      b.classList.toggle('active', on);
      return b;
    };
    effectsBox.append(toggle('grayscale', 'Grayscale'), toggle('invert', 'Invert'), toggle('posterize', 'Posterize'));
    const posterize = has('posterize');
    let levelsRow: HTMLElement | null = null;
    if (posterize) {
      const levels = this.numberField('levels', (v) => {
        const n = Math.round(clamp(v, 2, 32));
        setEffects(live().effects.map((e) => (e.kind === 'posterize' ? { kind: 'posterize', levels: n } : e)));
      });
      levelsRow = grid([[span('Levels'), levels, span('')]]);
    }

    const remove = button('Remove inherited block', () => {
      this.open = false;
      ws.removeBlock(id);
    }, 'Delete the block and all its settings');
    remove.classList.add('danger');

    box.append(
      sourceRow,
      row('Opacity', opacity, opacityOut),
      row('Blend', blend),
      heading('Placement'),
      mode,
      placement,
      placementButtons,
      heading('Crop'),
      buttons(crop, resetCrop),
      heading('Effects'),
      effectsBox,
      ...(levelsRow ? [levelsRow] : []),
      buttons(remove),
    );
    return box;
  }

  /** Canvases this one can inherit from; those that would make a cycle are disabled. */
  private sourceSelect(editor: Editor, current: CanvasId | null, placeholder: string): HTMLSelectElement {
    const ws = editor.workspace;
    const id = editor.doc.id;
    const select = document.createElement('select');
    if (current === null) select.append(new Option(placeholder, '', true, true));
    for (const c of ws.canvases) {
      if (c.id === id) continue;
      const option = new Option(c.name, c.id, false, c.id === current);
      option.disabled = !ws.canConnect(id, c.id);
      if (option.disabled) option.text += ' (would loop)';
      select.append(option);
    }
    select.addEventListener('change', () => {
      if (select.value) ws.connect(id, select.value);
    });
    return select;
  }

  // --- values ----------------------------------------------------------------------

  private refreshValues(block: InheritedBlock, ws: Workspace): void {
    if (this.summary) this.summary.textContent = summaryText(block, ws);
    const p = block.placement;
    const values: Record<string, string> = {
      opacity: String(block.opacity),
      blendMode: block.blendMode,
      x: round(p.x),
      y: round(p.y),
      scale: round(p.scale * 100, 1),
      rotation: round((p.rotation * 180) / Math.PI, 1),
      levels: String(block.effects.find((e) => e.kind === 'posterize')?.levels ?? DEFAULT_POSTERIZE_LEVELS),
    };
    for (const [key, field] of this.fields) {
      if (document.activeElement !== field && values[key] !== undefined) field.value = values[key];
    }
    const tool = this.editor ? this.actions.blockTool(this.editor.doc.id) : null;
    const transform = this.element.querySelector<HTMLButtonElement>('button[data-field="transform"]');
    if (transform) {
      transform.textContent = tool === 'transform' ? 'Done transforming' : 'Transform';
      transform.classList.toggle('active', tool === 'transform');
    }
    const crop = this.element.querySelector<HTMLButtonElement>('button[data-field="crop"]');
    if (crop) {
      crop.textContent = tool === 'crop' ? 'Done cropping' : 'Crop';
      crop.classList.toggle('active', tool === 'crop');
    }
    const out = this.element.querySelector<HTMLOutputElement>('output[data-field="opacityText"]');
    if (out) out.textContent = `${Math.round(block.opacity * 100)}%`;
  }

  /**
   * An approximate thumbnail: the source's layer thumbnails over its paper.
   * (It leaves out the source's own inherited block and this block's
   * effects; the canvas itself always shows the real result.)
   */
  private drawThumbnail(ws: Workspace, block: InheritedBlock | null): void {
    const ctx = this.thumbnail.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    const sourceId = block?.source.kind === 'linked' ? block.source.canvasId : null;
    if (!sourceId || !ws.hasCanvas(sourceId)) return;
    const source: PaintDocument = ws.canvas(sourceId);
    if (source.paperVisible) {
      ctx.fillStyle = `rgb(${source.paper.map((c) => Math.round(c * 255)).join(',')})`;
      ctx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    }
    for (const layer of source.layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
      ctx.drawImage(this.thumbnails.canvasFor(layer.id), 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- helpers ---------------------------------------------------------------------

  private set(changes: Parameters<Workspace['setBlock']>[1], mergeKey: string | null = null, label?: string): void {
    const editor = this.editor;
    if (editor) editor.workspace.setBlock(editor.doc.id, changes, label, mergeKey);
  }

  private input(key: string, type: string, attrs: Record<string, string> = {}): HTMLInputElement {
    const input = Object.assign(document.createElement('input'), { type }, attrs);
    this.fields.set(key, input);
    return input;
  }

  /** A number field that commits on change (Enter or leaving it): one undo step. */
  private numberField(key: string, commit: (value: number) => void): HTMLInputElement {
    const input = this.input(key, 'number', { step: 'any' });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (input.value !== '' && Number.isFinite(v)) commit(v);
    });
    return input;
  }
}

function summaryText(block: InheritedBlock, ws: Workspace): string {
  const s = block.source;
  const state =
    s.kind === 'linked' ? `from ${ws.hasCanvas(s.canvasId) ? ws.canvas(s.canvasId).name : '?'}` : s.kind === 'empty' ? 'empty (no source)' : 'source deleted';
  return `${state} · ${Math.round(block.opacity * 100)}% · ${block.blendMode}`;
}

function round(v: number, digits = 0): string {
  const k = 10 ** digits;
  return String(Math.round(v * k) / k);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function span(text: string): HTMLSpanElement {
  return Object.assign(document.createElement('span'), { textContent: text });
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function row(label: string, ...controls: HTMLElement[]): HTMLElement {
  const r = document.createElement('label');
  r.className = 'row';
  r.append(span(label), ...controls);
  return r;
}

function grid(rows: HTMLElement[][]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'block-grid';
  for (const cells of rows) box.append(...cells);
  return box;
}

function buttons(...items: HTMLElement[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'buttons';
  box.append(...items);
  return box;
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
