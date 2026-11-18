import type { Metrics, Stats } from './metrics';

/** How far back the live HUD looks. The JSON export always covers everything recorded. */
const HUD_WINDOW_MS = 2000;
const HUD_REFRESH_MS = 250;

function ms(s: Stats): string {
  if (s.p50 === null) return '—';
  return `${s.p50.toFixed(1)} / ${s.p95!.toFixed(1)}`;
}

function num(v: number | null, digits = 0): string {
  return v === null ? '—' : v.toFixed(digits);
}

/**
 * Text-only measurement overlay, refreshed a few times per second (not every
 * frame) so it doesn't add noticeable work to the frames it measures.
 */
export class Hud {
  readonly element: HTMLElement;
  private timer: number | null = null;

  constructor(
    private readonly metrics: Metrics,
    private readonly rendererLabel: () => string,
    private readonly extraLines: () => string[],
  ) {
    this.element = document.createElement('pre');
    this.element.className = 'hud';
    this.element.setAttribute('aria-live', 'off');
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (visible && this.timer === null) {
      this.update();
      this.timer = window.setInterval(() => this.update(), HUD_REFRESH_MS);
    } else if (!visible && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private update(): void {
    const now = performance.now();
    const s = this.metrics.summary(now - HUD_WINDOW_MS, now);
    const idle = s.frameInterval.count === 0;
    const c = this.metrics.counters;
    const lines = [
      `renderer       ${this.rendererLabel()}`,
      `fps            ${idle ? 'idle (renders on change)' : num(s.fps)}`,
      `frame ms       ${ms(s.frameInterval)}   (p50 / p95)`,
      `render cpu ms  ${ms(s.cpu)}`,
      `samples/s      ${num(s.samplesPerSecond)}`,
      `events/s       ${num(s.eventsPerSecond)}`,
      `coalesced/evt  ${num(s.coalescedPerEvent, 1)}`,
      `in→submit ms   ${ms(s.inputToSubmit)}   (estimate)`,
      `oldest→submit  ${ms(s.oldestInputToSubmit)}`,
      `in→gpu done ms ${ms(s.inputToGpuDone)}`,
      `strokes ${c.strokes}  cancelled ${c.cancelledStrokes}  palm-rejected ${c.palmRejections}`,
      ...this.extraLines(),
      `Estimated software latency only — not on-glass latency.`,
    ];
    this.element.textContent = lines.join('\n');
  }
}
