import type { Metrics, Stats } from './metrics';

/** How far back the live HUD looks. The JSON export always covers everything recorded. */
const HUD_WINDOW_MS = 2000;
const HUD_REFRESH_MS = 250;
/** Remembers expanded / collapsed across reloads (this browser only). */
const COLLAPSED_KEY = 'vc-prototype.hud-collapsed';

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
 *
 * Its header is a button that collapses it to one line (fps and chain
 * time), to see what drawing feels like without the numbers in the way.
 * The text itself lets pen strokes through to the canvas.
 */
export class Hud {
  readonly element: HTMLElement;
  private readonly toggle = document.createElement('button');
  private readonly text = document.createElement('pre');
  private collapsed = readCollapsed();
  private timer: number | null = null;

  constructor(
    private readonly metrics: Metrics,
    private readonly rendererLabel: () => string,
    private readonly extraLines: () => string[],
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hud';
    this.element.setAttribute('aria-live', 'off');
    this.toggle.type = 'button';
    this.toggle.className = 'hud-toggle';
    this.toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      writeCollapsed(this.collapsed);
      this.update();
    });
    this.element.append(this.toggle, this.text);
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
    const fps = idle ? 'idle' : `${num(s.fps)} fps`;
    const chain = s.chainEnd.p50 === null ? '' : ` · chain ${num(s.chainEnd.p50, 1)} ms`;
    this.element.classList.toggle('collapsed', this.collapsed);
    this.text.hidden = this.collapsed;
    this.toggle.textContent = this.collapsed ? `▸ ${fps}${chain}` : '▾ HUD';
    this.toggle.title = this.collapsed ? 'Show measurements' : 'Hide measurements';
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    if (this.collapsed) return;
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
      `composite      ${ms(s.compositedTiles).replace(/\.0/g, '')} tiles · cpu ${ms(s.compositeCpu)} · gpu ${ms(s.compositeGpu)} ms`,
      `strokes ${c.strokes}  cancelled ${c.cancelledStrokes}  palm-rejected ${c.palmRejections}`,
      `chain ms       ${ms(s.chainEnd)}   (source change → end of chain submitted)`,
      ...this.extraLines(),
      `Estimated software latency only — not on-glass latency.`,
    ];
    this.text.textContent = lines.join('\n');
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false; // storage blocked (e.g. private browsing): start expanded
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Not remembered; the toggle still works for this session.
  }
}
