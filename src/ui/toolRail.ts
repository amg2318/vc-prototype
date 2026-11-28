import brushIcon from '../assets/icons/drawing/brush.png';
import brushSettingsIcon from '../assets/icons/drawing/brush-settings.png';
import eraserIcon from '../assets/icons/drawing/eraser.png';
import pickerIcon from '../assets/icons/drawing/picker.png';
import railDivider from '../assets/icons/drawing/rail-divider.svg';
import redoIcon from '../assets/icons/drawing/redo.png';
import undoIcon from '../assets/icons/drawing/undo.png';
import type { BrushSettings } from '../brush/brushSettings';
import type { RGB } from '../document/blend';
import type { Tool } from '../tools/tools';
import { rgbToHex } from './color';
import { iconButton } from './iconButton';
import { logScale, VerticalSlider } from './verticalSlider';

export interface ToolRailActions {
  selectTool(tool: Tool): void;
  toggleColorPicker(): void;
  /** The brush or eraser size/opacity was dragged: the settings object was already changed. */
  settingsChanged(): void;
  toggleBrushSettings(): void;
  undo(): void;
  redo(): void;
}

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'brush', icon: brushIcon, label: 'Brush (B)' },
  { tool: 'eraser', icon: eraserIcon, label: 'Eraser (E)' },
  { tool: 'eyedropper', icon: pickerIcon, label: 'Picker (I)' },
];

const SIZE = logScale(1, 400);
const MIN_OPACITY = 0.05;

/**
 * The drawing page's tool rail down the left edge (Figma "drawing page"):
 * tools, colour, size and opacity of the brush or eraser, brush settings,
 * undo and redo.
 */
export class ToolRail {
  readonly element: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly swatch: HTMLButtonElement;
  private readonly size: VerticalSlider;
  private readonly opacity: VerticalSlider;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  /** The settings the sliders edit (brush or eraser), from the last `update`. */
  private settings: BrushSettings | null = null;

  constructor(private readonly actions: ToolRailActions) {
    this.element = document.createElement('nav');
    this.element.className = 'tool-rail';

    for (const { tool, icon, label } of TOOLS) {
      const b = iconButton(icon, label, () => actions.selectTool(tool));
      this.toolButtons.set(tool, b);
      this.element.append(b);
    }

    this.swatch = document.createElement('button');
    this.swatch.type = 'button';
    this.swatch.className = 'rail-swatch';
    this.swatch.title = 'Colour';
    this.swatch.setAttribute('aria-label', 'Colour');
    this.swatch.addEventListener('click', actions.toggleColorPicker);

    this.size = new VerticalSlider({
      label: 'Size',
      ...SIZE,
      format: (v) => `${v}px`,
      onInput: (v) => this.edit((s) => (s.diameter = v)),
    });
    this.opacity = new VerticalSlider({
      label: 'Opacity',
      toValue: (p) => MIN_OPACITY + p * (1 - MIN_OPACITY),
      toPosition: (v) => (v - MIN_OPACITY) / (1 - MIN_OPACITY),
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this.edit((s) => (s.opacity = v)),
    });

    const divider = Object.assign(document.createElement('img'), { src: railDivider, alt: '', draggable: false });
    divider.className = 'rail-divider';
    divider.setAttribute('aria-hidden', 'true');

    this.undoButton = iconButton(undoIcon, 'Undo (two-finger tap, ⌘Z)', actions.undo);
    this.redoButton = iconButton(redoIcon, 'Redo (three-finger tap, ⇧⌘Z)', actions.redo);
    const brushSettings = iconButton(brushSettingsIcon, 'Brush settings', actions.toggleBrushSettings);
    brushSettings.classList.add('rail-brush-settings');

    this.element.append(
      this.swatch,
      this.size.element,
      this.opacity.element,
      brushSettings,
      divider,
      this.undoButton,
      this.redoButton,
    );
    this.size.element.classList.add('rail-size');
    this.opacity.element.classList.add('rail-opacity');
  }

  /** Change the brush or eraser settings in place; the next stroke picks them up. */
  private edit(change: (settings: BrushSettings) => void): void {
    if (!this.settings) return;
    change(this.settings);
    this.actions.settingsChanged();
  }

  update(state: { tool: Tool; color: RGB; settings: BrushSettings; canUndo: boolean; canRedo: boolean }): void {
    for (const [tool, b] of this.toolButtons) b.classList.toggle('active', tool === state.tool);
    this.swatch.style.background = rgbToHex(state.color);
    this.settings = state.settings;
    this.size.setValue(state.settings.diameter);
    this.opacity.setValue(state.settings.opacity);
    this.undoButton.disabled = !state.canUndo;
    this.redoButton.disabled = !state.canRedo;
  }
}
