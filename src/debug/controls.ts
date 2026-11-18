import type { BrushSettings } from '../brush/brushSettings';
import { PRESSURE_CURVE_PRESETS, type PressureCurvePreset } from '../brush/pressureCurve';

export interface ControlActions {
  fitView(): void;
  toggleHud(): void;
  exportMeasurements(): void;
  resetMeasurements(): void;
  setRotationEnabled(enabled: boolean): void;
}

interface Binding {
  refresh(settings: BrushSettings): void;
}

/**
 * Brush panel: size and opacity of the current tool (brush or eraser), plus a
 * collapsible "Brush details & debug" section. Controls edit the settings
 * object returned by `settings()` in place; the next stroke picks them up.
 */
export class Controls {
  readonly element: HTMLElement;
  /** Extra debug content (e.g. stress mode) can be appended here. */
  readonly debugBody: HTMLElement;
  private readonly bindings: Binding[] = [];
  private readonly title: HTMLElement;

  constructor(
    private readonly settings: () => BrushSettings,
    private readonly toolName: () => string,
    actions: ControlActions,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'controls panel';
    this.title = document.createElement('div');
    this.title.className = 'controls-title';

    const main = document.createElement('div');
    main.className = 'controls-body';
    main.append(
      this.title,
      this.slider('Size', 1, 400, 1, (s) => s.diameter, (s, v) => (s.diameter = v), (v) => `${v}px`),
      this.slider('Opacity', 0.05, 1, 0.01, (s) => s.opacity, (s, v) => (s.opacity = v), pct),
    );

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Brush details & debug';
    this.debugBody = document.createElement('div');
    this.debugBody.className = 'controls-body';
    this.debugBody.append(
      this.slider('Spacing', 0.05, 0.5, 0.01, (s) => s.spacing, (s, v) => (s.spacing = v), pct),
      this.slider('Smoothing', 0, 1, 0.01, (s) => s.smoothing, (s, v) => (s.smoothing = v), pct),
      this.select('Pressure curve', Object.keys(PRESSURE_CURVE_PRESETS), (s) => s.pressureCurve,
        (s, v) => (s.pressureCurve = v as PressureCurvePreset)),
      this.checkbox('Pressure → size', (s) => s.pressureAffectsSize, (s, v) => (s.pressureAffectsSize = v)),
      this.checkbox('Pressure → opacity', (s) => s.pressureAffectsOpacity, (s, v) => (s.pressureAffectsOpacity = v)),
      this.checkbox('Mouse/finger: pressure from speed', (s) => s.pressureFromSpeed, (s, v) => (s.pressureFromSpeed = v)),
      plainCheckbox('Two-finger rotate', false, actions.setRotationEnabled),
      buttons([
        ['Fit view', actions.fitView],
        ['Toggle HUD', actions.toggleHud],
      ]),
      buttons([
        ['Export JSON', actions.exportMeasurements],
        ['Reset stats', actions.resetMeasurements],
      ]),
    );
    details.append(summary, this.debugBody);
    this.element.append(main, details);
    this.refresh();
  }

  /** Re-read values (after the tool or a setting changed elsewhere, e.g. via [ and ]). */
  refresh(): void {
    this.title.textContent = this.toolName();
    const s = this.settings();
    for (const b of this.bindings) b.refresh(s);
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: (s: BrushSettings) => number,
    set: (s: BrushSettings, v: number) => void,
    format: (v: number) => string,
  ): HTMLElement {
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
    const output = document.createElement('output');
    input.addEventListener('input', () => {
      set(this.settings(), Number(input.value));
      output.textContent = format(Number(input.value));
    });
    this.bindings.push({
      refresh(s) {
        input.value = String(get(s));
        output.textContent = format(get(s));
      },
    });
    return row(label, input, output);
  }

  private select(
    label: string,
    options: string[],
    get: (s: BrushSettings) => string,
    set: (s: BrushSettings, v: string) => void,
  ): HTMLElement {
    const el = document.createElement('select');
    for (const o of options) el.append(new Option(o, o));
    el.addEventListener('change', () => set(this.settings(), el.value));
    this.bindings.push({ refresh: (s) => (el.value = get(s)) });
    return row(label, el);
  }

  private checkbox(
    label: string,
    get: (s: BrushSettings) => boolean,
    set: (s: BrushSettings, v: boolean) => void,
  ): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.addEventListener('change', () => set(this.settings(), el.checked));
    this.bindings.push({ refresh: (s) => (el.checked = get(s)) });
    return row(label, el);
  }
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

function plainCheckbox(labelText: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = initial;
  el.addEventListener('change', () => onChange(el.checked));
  return row(labelText, el);
}

export function buttons(items: [string, () => void][]): HTMLElement {
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
