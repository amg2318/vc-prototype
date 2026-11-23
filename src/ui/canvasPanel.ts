import { MAX_CANVAS_SIZE } from '../config';
import type { Anchor } from '../document/retile';
import type { PaintDocument } from '../document/paintDocument';
import { CANVAS_PRESETS } from '../workspace/presets';

type Size = { width: number; height: number };

export interface CanvasPanelActions {
  create(size: Size): void;
  /** Select a canvas and bring it into view (tapping a row in the list). */
  show(canvasId: string): void;
  rename(canvasId: string, name: string): void;
  resize(canvasId: string, size: Size, anchor: Anchor): void;
  duplicate(canvasId: string): void;
  remove(canvasId: string): void;
  bringToFront(canvasId: string): void;
  /** Save the canvas as a PNG at full resolution (Phase 4). */
  exportPng(canvasId: string): void;
  fitAll(): void;
}

/** Snapping while dragging a canvas by its label. Read by the app on each move. */
export interface SnapSettings {
  edges: boolean;
  grid: boolean;
}

const CUSTOM = 'custom';

/**
 * The Canvases panel:
 *  - a list of every canvas (the navigator): tap one to select it and zoom to it;
 *  - "New canvas" from a preset or a custom size (≤ MAX_CANVAS_SIZE);
 *  - the selected canvas's name, size (resize around an anchor), and
 *    duplicate / bring to front / delete;
 *  - snapping options for dragging canvases by their labels.
 * Every change goes through the workspace, so it can be undone.
 */
export class CanvasPanel {
  readonly element = document.createElement('aside');
  readonly snapping: SnapSettings = { edges: true, grid: false };
  private readonly list = document.createElement('ol');
  private readonly details = document.createElement('section');
  private readonly nameInput = textInput();
  private readonly resizeSize: SizePicker;
  private anchor: Anchor = { x: 0.5, y: 0.5 };
  private readonly anchorButtons: HTMLButtonElement[] = [];
  private signature = '';
  private selectedId: string | null = null;

  constructor(
    private readonly canvases: () => readonly PaintDocument[],
    private readonly activeId: () => string | null,
    private readonly actions: CanvasPanelActions,
  ) {
    this.element.className = 'canvases panel';
    this.element.hidden = true;

    const header = document.createElement('header');
    header.append(heading('Canvases'), button('Fit all', actions.fitAll, 'Zoom to fit all canvases (⇧1)'));

    // New canvas.
    const create = section('New canvas');
    const newSize = new SizePicker({ width: CANVAS_PRESETS[0]!.width, height: CANVAS_PRESETS[0]!.height });
    create.append(newSize.element, button('Create', () => actions.create(newSize.value()), 'Create a canvas of this size'));

    // Selected canvas.
    const id = (): string | null => this.selectedId;
    this.nameInput.addEventListener('change', () => {
      const canvasId = id();
      if (canvasId) actions.rename(canvasId, this.nameInput.value);
    });
    this.resizeSize = new SizePicker({ width: 1, height: 1 });
    const resizeButton = button('Resize', () => {
      const canvasId = id();
      if (canvasId) actions.resize(canvasId, this.resizeSize.value(), this.anchor);
    }, 'Change the canvas size; the anchor stays in place');
    const commands = document.createElement('div');
    commands.className = 'button-row';
    commands.append(
      button('Duplicate', () => id() && actions.duplicate(id()!), 'Duplicate canvas'),
      button('To front', () => id() && actions.bringToFront(id()!), 'Bring to front'),
      button('Delete', () => id() && actions.remove(id()!), 'Delete canvas (undo brings it back)'),
      button('Export PNG', () => id() && actions.exportPng(id()!), 'Save this canvas as a PNG at full resolution, inherited content included'),
    );
    this.details.append(
      heading('Selected canvas', 'h3'),
      labelled('Name', this.nameInput),
      this.resizeSize.element,
      labelled('Anchor', this.anchorGrid()),
      resizeButton,
      commands,
    );

    // Snapping.
    const snap = section('Snap when moving');
    snap.append(
      checkbox('Canvas edges', this.snapping.edges, (on) => (this.snapping.edges = on)),
      checkbox('Grid (256 px)', this.snapping.grid, (on) => (this.snapping.grid = on)),
    );

    this.element.append(header, this.list, this.details, create, snap);
    this.update();
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (visible) this.update();
  }

  update(): void {
    if (this.element.hidden) return;
    const canvases = this.canvases();
    const activeId = this.activeId();
    const signature = JSON.stringify([activeId, canvases.map((c) => [c.id, c.name, c.width, c.height])]);
    if (signature === this.signature) return;
    this.signature = signature;

    // Front-most canvas first, like a layer list.
    this.list.replaceChildren(...[...canvases].reverse().map((c) => this.row(c, c.id === activeId)));

    const active = canvases.find((c) => c.id === activeId) ?? null;
    this.details.hidden = active === null;
    if (!active) return;
    const changedSelection = active.id !== this.selectedId;
    this.selectedId = active.id;
    if (document.activeElement !== this.nameInput) this.nameInput.value = active.name;
    if (changedSelection || !this.resizeSize.focused) this.resizeSize.set(active);
  }

  private row(canvas: PaintDocument, active: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'canvas-row';
    li.classList.toggle('active', active);
    const name = document.createElement('span');
    name.textContent = canvas.name;
    const size = document.createElement('span');
    size.className = 'canvas-size';
    size.textContent = `${canvas.width} × ${canvas.height}`;
    li.append(name, size);
    li.addEventListener('click', () => this.actions.show(canvas.id));
    return li;
  }

  /** A 3 × 3 grid of buttons choosing where the canvas stays put when resized. */
  private anchorGrid(): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'anchor-grid';
    const steps = [0, 0.5, 1] as const;
    for (const y of steps) {
      for (const x of steps) {
        const b = button('', () => {
          this.anchor = { x, y };
          this.anchorButtons.forEach((other) => other.classList.toggle('active', other === b));
        }, `Anchor ${['left', 'centre', 'right'][x * 2]} ${['top', 'middle', 'bottom'][y * 2]}`);
        b.classList.toggle('active', x === this.anchor.x && y === this.anchor.y);
        this.anchorButtons.push(b);
        grid.append(b);
      }
    }
    return grid;
  }
}

/** A preset menu plus width and height fields (the fields are used for "Custom"). */
class SizePicker {
  readonly element = document.createElement('div');
  private readonly preset = document.createElement('select');
  private readonly width = numberInput();
  private readonly height = numberInput();

  constructor(initial: Size) {
    this.element.className = 'size-picker';
    for (const p of CANVAS_PRESETS) {
      this.preset.append(new Option(`${p.name} — ${p.width} × ${p.height}`, p.name));
    }
    this.preset.append(new Option('Custom', CUSTOM));
    this.preset.addEventListener('change', () => {
      const p = CANVAS_PRESETS.find((p) => p.name === this.preset.value);
      if (p) this.setFields(p);
    });
    // Typing a size switches the menu to whichever preset matches, or Custom.
    const fieldsChanged = (): void => {
      this.preset.value = matchingPreset(this.value());
    };
    this.width.addEventListener('input', fieldsChanged);
    this.height.addEventListener('input', fieldsChanged);
    const fields = document.createElement('div');
    fields.className = 'size-fields';
    fields.append(this.width, document.createTextNode('×'), this.height);
    this.element.append(this.preset, fields);
    this.set(initial);
  }

  get focused(): boolean {
    return this.element.contains(document.activeElement);
  }

  set(size: Size): void {
    this.setFields(size);
    this.preset.value = matchingPreset(size);
  }

  value(): Size {
    const clamp = (input: HTMLInputElement): number =>
      Math.max(1, Math.min(MAX_CANVAS_SIZE, Math.round(Number(input.value) || 1)));
    return { width: clamp(this.width), height: clamp(this.height) };
  }

  private setFields(size: Size): void {
    this.width.value = String(size.width);
    this.height.value = String(size.height);
  }
}

function matchingPreset(size: Size): string {
  return CANVAS_PRESETS.find((p) => p.width === size.width && p.height === size.height)?.name ?? CUSTOM;
}

// --- small DOM helpers ---------------------------------------------------------

function button(text: string, onClick: () => void, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function heading(text: string, tag: 'h2' | 'h3' = 'h2'): HTMLElement {
  return Object.assign(document.createElement(tag), { textContent: text });
}

function section(title: string): HTMLElement {
  const s = document.createElement('section');
  s.append(heading(title, 'h3'));
  return s;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'field';
  label.append(Object.assign(document.createElement('span'), { textContent: text }), control);
  return label;
}

function checkbox(text: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const label = labelled(text, input);
  return label;
}

function textInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  return input;
}

function numberInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = String(MAX_CANVAS_SIZE);
  input.inputMode = 'numeric';
  return input;
}
