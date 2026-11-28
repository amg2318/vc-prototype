import type { BrushSettings } from '../brush/brushSettings';
import { PRESSURE_CURVE_PRESETS, type PressureCurvePreset } from '../brush/pressureCurve';
import { Popover, row } from './formRows';

interface Binding {
  refresh(settings: BrushSettings): void;
}

/**
 * Brush settings popover (the rail's brush settings button): how the brush or
 * eraser responds to the pen. Size and opacity are on the rail itself.
 * Controls edit the settings object returned by `settings()` in place; the
 * next stroke picks them up.
 */
export class BrushPanel extends Popover {
  private readonly bindings: Binding[] = [];
  private readonly title: HTMLElement;

  constructor(
    private readonly settings: () => BrushSettings,
    private readonly toolName: () => string,
  ) {
    super('brush-panel');
    this.title = document.createElement('div');
    this.title.className = 'popover-title';

    const body = document.createElement('div');
    body.className = 'popover-body';
    body.append(
      this.title,
      this.slider('Spacing', 0.05, 0.5, 0.01, (s) => s.spacing, (s, v) => (s.spacing = v), pct),
      this.slider('Smoothing', 0, 1, 0.01, (s) => s.smoothing, (s, v) => (s.smoothing = v), pct),
      this.select('Pressure curve', Object.keys(PRESSURE_CURVE_PRESETS), (s) => s.pressureCurve,
        (s, v) => (s.pressureCurve = v as PressureCurvePreset)),
      this.checkbox('Pressure → size', (s) => s.pressureAffectsSize, (s, v) => (s.pressureAffectsSize = v)),
      this.checkbox('Pressure → opacity', (s) => s.pressureAffectsOpacity, (s, v) => (s.pressureAffectsOpacity = v)),
      this.slider('Full opacity at pressure', 0.1, 1, 0.05, (s) => s.fullOpacityPressure,
        (s, v) => (s.fullOpacityPressure = v), pct),
      this.checkbox('Mouse/finger: pressure from speed', (s) => s.pressureFromSpeed, (s, v) => (s.pressureFromSpeed = v)),
    );
    this.element.append(body);
    this.refresh();
  }

  /** Re-read values (after the tool or a setting changed elsewhere). */
  refresh(): void {
    this.title.textContent = `${this.toolName()} settings`;
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
