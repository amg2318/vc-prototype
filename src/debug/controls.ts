import type { BrushSettings } from '../brush/brushSettings';
import { PRESSURE_CURVE_PRESETS, type PressureCurvePreset } from '../brush/pressureCurve';

export interface ControlActions {
  clearCanvas(): void;
  fitView(): void;
  toggleHud(): void;
  exportMeasurements(): void;
  resetMeasurements(): void;
  setRotationEnabled(enabled: boolean): void;
}

/** Plain-DOM debug panel. Edits `brush` in place; the next stroke picks the values up. */
export function createControls(brush: BrushSettings, actions: ControlActions): HTMLElement {
  const panel = document.createElement('details');
  panel.className = 'controls';
  panel.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Brush & debug';
  panel.append(summary);

  const body = document.createElement('div');
  body.className = 'controls-body';
  panel.append(body);

  body.append(
    slider('Size', 1, 200, 1, brush.diameter, (v) => (brush.diameter = v), (v) => `${v}px`),
    slider('Opacity', 0.05, 1, 0.01, brush.opacity, (v) => (brush.opacity = v), pct),
    slider('Spacing', 0.05, 0.5, 0.01, brush.spacing, (v) => (brush.spacing = v), pct),
    slider('Smoothing', 0, 1, 0.01, brush.smoothing, (v) => (brush.smoothing = v), pct),
    select(
      'Pressure curve',
      Object.keys(PRESSURE_CURVE_PRESETS),
      brush.pressureCurve,
      (v) => (brush.pressureCurve = v as PressureCurvePreset),
    ),
    checkbox('Pressure → size', brush.pressureAffectsSize, (v) => (brush.pressureAffectsSize = v)),
    checkbox('Pressure → opacity', brush.pressureAffectsOpacity, (v) => (brush.pressureAffectsOpacity = v)),
    colorInput('Color', brush.color, (rgb) => (brush.color = rgb)),
    checkbox('Two-finger rotate', false, actions.setRotationEnabled),
    buttons([
      ['Clear canvas', actions.clearCanvas],
      ['Fit view', actions.fitView],
    ]),
    buttons([
      ['Toggle HUD', actions.toggleHud],
      ['Export JSON', actions.exportMeasurements],
      ['Reset stats', actions.resetMeasurements],
    ]),
  );
  return panel;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

function row(labelText: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  label.className = 'row';
  const name = document.createElement('span');
  name.textContent = labelText;
  label.append(name, control);
  if (value) label.append(value);
  return label;
}

function slider(
  labelText: string,
  min: number,
  max: number,
  step: number,
  initial: number,
  onChange: (v: number) => void,
  format: (v: number) => string,
): HTMLElement {
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(initial) });
  const value = document.createElement('output');
  value.textContent = format(initial);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = format(v);
    onChange(v);
  });
  return row(labelText, input, value);
}

function select(labelText: string, options: string[], initial: string, onChange: (v: string) => void): HTMLElement {
  const el = document.createElement('select');
  for (const o of options) el.append(new Option(o, o, o === initial, o === initial));
  el.addEventListener('change', () => onChange(el.value));
  return row(labelText, el);
}

function checkbox(labelText: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = initial;
  el.addEventListener('change', () => onChange(el.checked));
  return row(labelText, el);
}

function colorInput(
  labelText: string,
  initial: [number, number, number],
  onChange: (rgb: [number, number, number]) => void,
): HTMLElement {
  const el = document.createElement('input');
  el.type = 'color';
  el.value = '#' + initial.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  el.addEventListener('input', () => {
    const hex = el.value.slice(1);
    onChange([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]);
  });
  return row(labelText, el);
}

function buttons(items: [string, () => void][]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'buttons';
  for (const [text, onClick] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    wrap.append(b);
  }
  return wrap;
}
