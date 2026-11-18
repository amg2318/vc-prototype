/**
 * Light stabilizer: a time-based exponential moving average on position and
 * pressure.
 *
 * Time-based (rather than per-sample) smoothing behaves the same whether the
 * device delivers 60 Hz mouse events or 240 Hz Apple Pencil samples: each
 * sample moves the output a fraction `1 - exp(-dt / tau)` toward the input.
 * `amount` 0 disables smoothing entirely; 1 corresponds to `MAX_TAU_MS`.
 */

export interface StrokePoint {
  x: number;
  y: number;
  /** Effective pressure, 0..1. */
  pressure: number;
  /** ms */
  time: number;
}

/** Time constant at amount = 1. ~60 ms is strong but still usable. */
export const MAX_TAU_MS = 60;
/** Used when consecutive samples share a timestamp (happens with coalesced events). */
const FALLBACK_DT_MS = 4;

export class Stabilizer {
  private current: StrokePoint | null = null;

  constructor(private amount: number) {}

  setAmount(amount: number): void {
    this.amount = Math.min(1, Math.max(0, amount));
  }

  reset(first: StrokePoint): StrokePoint {
    this.current = { ...first };
    return { ...first };
  }

  push(p: StrokePoint): StrokePoint {
    const cur = this.current;
    if (!cur || this.amount <= 0) {
      this.current = { ...p };
      return { ...p };
    }
    const dt = p.time > cur.time ? p.time - cur.time : FALLBACK_DT_MS;
    const tau = this.amount * MAX_TAU_MS;
    const alpha = 1 - Math.exp(-dt / tau);
    const next: StrokePoint = {
      x: cur.x + (p.x - cur.x) * alpha,
      y: cur.y + (p.y - cur.y) * alpha,
      pressure: cur.pressure + (p.pressure - cur.pressure) * alpha,
      time: p.time,
    };
    this.current = next;
    return { ...next };
  }

  /**
   * End of stroke: the smoothed position lags behind the pen, so jump to the
   * last raw position to make the stroke end where the pen lifted. Pressure
   * keeps its smoothed value so the tail doesn't flare.
   */
  finish(lastRaw: StrokePoint): StrokePoint | null {
    const cur = this.current;
    this.current = null;
    if (!cur) return null;
    if (cur.x === lastRaw.x && cur.y === lastRaw.y) return null;
    return { x: lastRaw.x, y: lastRaw.y, pressure: cur.pressure, time: lastRaw.time };
  }

  clone(): Stabilizer {
    const copy = new Stabilizer(this.amount);
    copy.current = this.current ? { ...this.current } : null;
    return copy;
  }
}
