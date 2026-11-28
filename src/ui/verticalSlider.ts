/**
 * A vertical bar with a horizontal thumb, as in the drawing page's tool rail
 * (brush size and opacity). The top of the bar is the largest value.
 *
 * The slider works in a 0..1 position; `toValue` and `toPosition` map that to
 * the setting (e.g. a log scale for brush size). Drag anywhere on the bar, or
 * use the arrow keys when it has focus.
 */
export interface VerticalSliderOptions {
  label: string;
  /** Position 0..1 (bottom..top) → setting value. */
  toValue(position: number): number;
  /** Setting value → position 0..1. */
  toPosition(value: number): number;
  /** Text read out by screen readers and shown as the tooltip, e.g. "12px". */
  format(value: number): string;
  onInput(value: number): void;
}

/** The thumb stays this far from the bar's top and bottom ends (CSS px, from the design). */
const END_GAP = 11;
const THUMB_HEIGHT = 9;
const KEY_STEP = 0.05;

export class VerticalSlider {
  readonly element: HTMLElement;
  private readonly thumb: HTMLElement;
  private position = 0;

  constructor(private readonly options: VerticalSliderOptions) {
    this.element = document.createElement('div');
    this.element.className = 'vertical-slider';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'slider');
    this.element.setAttribute('aria-orientation', 'vertical');
    this.element.setAttribute('aria-label', options.label);
    this.thumb = document.createElement('div');
    this.thumb.className = 'vertical-slider-thumb';
    this.element.append(this.thumb);

    this.element.addEventListener('pointerdown', (e) => {
      this.element.setPointerCapture(e.pointerId);
      this.dragTo(e.clientY);
    });
    this.element.addEventListener('pointermove', (e) => {
      if (this.element.hasPointerCapture(e.pointerId)) this.dragTo(e.clientY);
    });
    this.element.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowDown' ? -KEY_STEP : 0;
      if (step === 0) return;
      e.preventDefault();
      this.userSet(this.position + step);
    });
  }

  /** Show `value` without reporting it (after the tool or the setting changed elsewhere). */
  setValue(value: number): void {
    this.show(clamp01(this.options.toPosition(value)), value);
  }

  private dragTo(clientY: number): void {
    const rect = this.element.getBoundingClientRect();
    const travel = rect.height - 2 * END_GAP - THUMB_HEIGHT;
    // The thumb's middle follows the finger.
    const fromTop = clientY - rect.top - END_GAP - THUMB_HEIGHT / 2;
    this.userSet(1 - fromTop / travel);
  }

  private userSet(position: number): void {
    const p = clamp01(position);
    const value = this.options.toValue(p);
    this.show(p, value);
    this.options.onInput(value);
  }

  private show(position: number, value: number): void {
    this.position = position;
    // `top` as a fraction of the travel, so the bar can be any height.
    this.thumb.style.top = `calc(${END_GAP}px + ${1 - position} * (100% - ${2 * END_GAP + THUMB_HEIGHT}px))`;
    const text = this.options.format(value);
    this.element.setAttribute('aria-valuenow', String(value));
    this.element.setAttribute('aria-valuetext', text);
    this.element.title = `${this.options.label}: ${text}`;
  }
}

/** Log scale between `min` and `max`, so small sizes get as much of the bar as large ones. */
export function logScale(min: number, max: number): { toValue(p: number): number; toPosition(v: number): number } {
  const ratio = Math.log(max / min);
  return {
    toValue: (p) => Math.round(min * Math.exp(clamp01(p) * ratio)),
    toPosition: (v) => Math.log(Math.max(min, v) / min) / ratio,
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
