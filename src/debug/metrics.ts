import type { PenSample } from '../input/penSample';
import type { FrameInfo } from '../render/renderer';

/**
 * Measurement collection for the HUD and the JSON export.
 *
 * Latency here is an ESTIMATE of software latency only: from the input
 * event's timestamp to (a) the moment our GPU work for that frame was
 * submitted and (b, WebGPU only) the moment the GPU reported that work done.
 * It does not include display scan-out, compositor queuing or digitizer
 * latency, so true on-glass latency is higher. Measuring that needs a camera.
 */

export interface FrameRecord {
  /** rAF timestamp (ms, performance.now() clock). */
  t: number;
  /** ms since the previous rendered frame; null if the app was idle in between. */
  intervalMs: number | null;
  /** CPU time spent in renderer.render(). */
  cpuMs: number;
  /** Real (coalesced) input samples consumed by this frame. */
  samples: number;
  /** pointermove events consumed by this frame. */
  events: number;
  dabs: number;
  predictedDabs: number;
  /** Newest consumed sample → GPU work submitted. */
  inputToSubmitMs: number | null;
  /** Oldest consumed sample → GPU work submitted (worst case inside the frame). */
  oldestInputToSubmitMs: number | null;
  /** Newest consumed sample → GPU reported work done (WebGPU only). */
  inputToGpuDoneMs: number | null;
  /** Tiles recomposited this frame. */
  compositedTiles: number;
  /** CPU time encoding the composite pass. */
  compositeCpuMs: number;
  /** GPU time of the composite pass (WebGPU with timestamp queries only). */
  compositeGpuMs: number | null;
}

export interface Stats {
  count: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface MetricsSummary {
  fps: number | null;
  frameInterval: Stats;
  cpu: Stats;
  samplesPerSecond: number | null;
  eventsPerSecond: number | null;
  coalescedPerEvent: number | null;
  inputToSubmit: Stats;
  oldestInputToSubmit: Stats;
  inputToGpuDone: Stats;
  /** Composite GPU time per frame that recomposited anything (WebGPU timestamp queries only). */
  compositeGpu: Stats;
  /** Tiles recomposited per frame that recomposited anything. */
  compositedTiles: Stats;
}

/** Frames further apart than this are not "consecutive" (the app was idle). */
const IDLE_GAP_MS = 100;
/** Latencies outside 0..this are treated as clock mismatches and discarded. */
const MAX_PLAUSIBLE_LATENCY_MS = 1000;
const MAX_RECORDS = 100_000;

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function computeStats(values: readonly (number | null)[]): Stats {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { count: 0, mean: null, p50: null, p95: null, max: null };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { count: v.length, mean, p50: percentile(v, 50), p95: percentile(v, 95), max: v[v.length - 1]! };
}

/** Samples per second from a list of timestamps (ms), or null if the span is too short. */
export function rateFromTimestamps(timestamps: readonly number[], minSpanMs = 100): number | null {
  if (timestamps.length < 2) return null;
  const span = timestamps[timestamps.length - 1]! - timestamps[0]!;
  return span >= minSpanMs ? ((timestamps.length - 1) / span) * 1000 : null;
}

export function plausibleLatency(fromEventMs: number, toMs: number): number | null {
  const latency = toMs - fromEventMs;
  return latency >= 0 && latency <= MAX_PLAUSIBLE_LATENCY_MS ? latency : null;
}

export class Metrics {
  readonly frames: FrameRecord[] = [];
  counters = { strokes: 0, cancelledStrokes: 0, palmRejections: 0, implausibleTimestamps: 0 };

  private pending = { samples: 0, events: 0, dabs: 0, predictedDabs: 0, oldest: Infinity, newest: -Infinity };
  private recentSampleTimes: number[] = [];
  private recentEventTimes: number[] = [];
  private lastFrameTime: number | null = null;

  /** Record one pointermove's worth of real samples. */
  noteInput(samples: readonly PenSample[], eventTime: number): void {
    this.pending.events += 1;
    this.pending.samples += samples.length;
    for (const s of samples) {
      this.pending.oldest = Math.min(this.pending.oldest, s.timeStamp);
      this.pending.newest = Math.max(this.pending.newest, s.timeStamp);
      this.recentSampleTimes.push(s.timeStamp);
    }
    this.recentEventTimes.push(eventTime);
  }

  noteDabs(real: number, predicted: number): void {
    this.pending.dabs += real;
    this.pending.predictedDabs = predicted; // only the latest prediction is drawn
  }

  /** Call once per rendered frame, after renderer.render(). */
  frameRendered(rafTime: number, cpuMs: number, info: FrameInfo): void {
    const p = this.pending;
    const hasInput = p.samples > 0;
    let inputToSubmit: number | null = null;
    let oldestToSubmit: number | null = null;
    if (hasInput) {
      inputToSubmit = plausibleLatency(p.newest, info.submittedAt);
      oldestToSubmit = plausibleLatency(p.oldest, info.submittedAt);
      if (inputToSubmit === null) this.counters.implausibleTimestamps++;
    }
    const interval =
      this.lastFrameTime !== null && rafTime - this.lastFrameTime <= IDLE_GAP_MS ? rafTime - this.lastFrameTime : null;
    this.lastFrameTime = rafTime;

    const record: FrameRecord = {
      t: rafTime,
      intervalMs: interval,
      cpuMs,
      samples: p.samples,
      events: p.events,
      dabs: p.dabs,
      predictedDabs: p.predictedDabs,
      inputToSubmitMs: inputToSubmit,
      oldestInputToSubmitMs: oldestToSubmit,
      inputToGpuDoneMs: null,
      compositedTiles: info.compositedTiles,
      compositeCpuMs: info.compositeCpuMs,
      compositeGpuMs: null,
    };
    if (this.frames.length < MAX_RECORDS) this.frames.push(record);

    void info.compositeGpuMs?.then((gpuMs) => {
      record.compositeGpuMs = gpuMs;
    });
    if (hasInput && info.gpuDone) {
      const newest = p.newest;
      void info.gpuDone.then((doneAt) => {
        record.inputToGpuDoneMs = plausibleLatency(newest, doneAt);
      });
    }
    this.pending = { samples: 0, events: 0, dabs: 0, predictedDabs: 0, oldest: Infinity, newest: -Infinity };
  }

  /** Summary over frames with t >= since (default: everything recorded). */
  summary(since = -Infinity, now = performance.now()): MetricsSummary {
    const frames = this.frames.filter((f) => f.t >= since);
    const inputFrames = frames.filter((f) => f.samples > 0);
    const compositeFrames = frames.filter((f) => f.compositedTiles > 0);
    const interval = computeStats(frames.map((f) => f.intervalMs));
    const totalEvents = inputFrames.reduce((n, f) => n + f.events, 0);
    const totalSamples = inputFrames.reduce((n, f) => n + f.samples, 0);

    // Input rates are measured over the last second of input, so they show the
    // device's sampling rate while drawing rather than an average including pauses.
    const cutoff = now - 1000;
    this.recentSampleTimes = this.recentSampleTimes.filter((t) => t >= cutoff);
    this.recentEventTimes = this.recentEventTimes.filter((t) => t >= cutoff);

    return {
      fps: interval.p50 ? 1000 / interval.p50 : null,
      frameInterval: interval,
      cpu: computeStats(frames.map((f) => f.cpuMs)),
      samplesPerSecond: rateFromTimestamps(this.recentSampleTimes),
      eventsPerSecond: rateFromTimestamps(this.recentEventTimes),
      coalescedPerEvent: totalEvents > 0 ? totalSamples / totalEvents : null,
      inputToSubmit: computeStats(inputFrames.map((f) => f.inputToSubmitMs)),
      oldestInputToSubmit: computeStats(inputFrames.map((f) => f.oldestInputToSubmitMs)),
      inputToGpuDone: computeStats(inputFrames.map((f) => f.inputToGpuDoneMs)),
      compositeGpu: computeStats(compositeFrames.map((f) => f.compositeGpuMs)),
      compositedTiles: computeStats(compositeFrames.map((f) => f.compositedTiles)),
    };
  }

  reset(): void {
    this.frames.length = 0;
    this.counters = { strokes: 0, cancelledStrokes: 0, palmRejections: 0, implausibleTimestamps: 0 };
    this.recentSampleTimes = [];
    this.recentEventTimes = [];
    this.lastFrameTime = null;
  }
}
