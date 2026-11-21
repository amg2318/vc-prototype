import type { RGB } from '../document/blend';
import type { Tool } from '../tools/tools';
import { rgbToHex } from './color';

export interface ToolbarActions {
  selectTool(tool: Tool): void;
  undo(): void;
  redo(): void;
  toggleColorPicker(): void;
  toggleLayers(): void;
  toggleCanvases(): void;
  toggleFingerDrawing(): void;
  toggleArrows(): void;
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'brush', label: 'Brush', key: 'B' },
  { tool: 'eraser', label: 'Eraser', key: 'E' },
  { tool: 'eyedropper', label: 'Picker', key: 'I' },
];

/** Top toolbar: tools, colour, undo/redo, layers. Every target is at least 44 px. */
export class Toolbar {
  readonly element: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly swatch: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly fingerButton: HTMLButtonElement;
  private readonly arrowsButton: HTMLButtonElement;

  constructor(actions: ToolbarActions) {
    this.element = document.createElement('nav');
    this.element.className = 'toolbar panel';

    for (const { tool, label, key } of TOOLS) {
      const b = button(label, () => actions.selectTool(tool), `${label} (${key})`);
      this.toolButtons.set(tool, b);
      this.element.append(b);
    }
    this.swatch = button('', actions.toggleColorPicker, 'Colour');
    this.swatch.classList.add('swatch', 'toolbar-swatch');
    this.undoButton = button('↶', actions.undo, 'Undo (two-finger tap, ⌘Z)');
    this.redoButton = button('↷', actions.redo, 'Redo (three-finger tap, ⇧⌘Z)');
    this.fingerButton = button('Finger', actions.toggleFingerDrawing, 'Finger drawing on/off');
    this.arrowsButton = button('Arrows', actions.toggleArrows, 'Show arrows between canvases');
    this.element.append(
      this.swatch,
      separator(),
      this.undoButton,
      this.redoButton,
      this.fingerButton,
      separator(),
      this.arrowsButton,
      button('Canvases', actions.toggleCanvases, 'Canvases'),
      button('Layers', actions.toggleLayers, 'Layers'),
    );
  }

  update(state: { tool: Tool; color: RGB; canUndo: boolean; canRedo: boolean; fingerDraws: boolean; showArrows: boolean }): void {
    this.arrowsButton.classList.toggle('active', state.showArrows);
    this.arrowsButton.title = state.showArrows ? 'Hide arrows between canvases' : 'Show arrows between canvases';
    // Lit while one finger draws; dim while one finger pans.
    this.fingerButton.classList.toggle('active', state.fingerDraws);
    this.fingerButton.title = state.fingerDraws ? 'One finger draws (tap: finger pans)' : 'One finger pans (tap: finger draws)';
    for (const [tool, b] of this.toolButtons) b.classList.toggle('active', tool === state.tool);
    this.swatch.style.background = rgbToHex(state.color);
    this.undoButton.disabled = !state.canUndo;
    this.redoButton.disabled = !state.canRedo;
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

function separator(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'toolbar-separator';
  return s;
}
