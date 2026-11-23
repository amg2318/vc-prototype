/**
 * When to save the working copy. Pure logic: the clock and the save itself
 * are passed in, so every trigger is unit-tested.
 *
 * Rules (the Phase 4 gate is "a force-close loses at most the last stroke"):
 *  - Any change starts (or restarts) a short debounce (SAVE.debounceMs);
 *    when it runs out with no stroke in progress, save.
 *  - A stroke that ends while an earlier stroke is still unsaved saves at
 *    once. A debounce alone would keep restarting during fast hatching and
 *    could leave many strokes unsaved; with this rule at most one is.
 *  - `flush()` (the page is being hidden or closed) saves at once.
 *  - One save runs at a time. Changes during a save are saved by the next
 *    one, which starts as soon as the current one ends if it is already due.
 */

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export const browserTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle),
};

export class AutosaveScheduler {
  private dirty = false;
  /** Strokes ended since the last save started. */
  private unsavedStrokes = 0;
  private strokeInProgress = false;
  private saving = false;
  /** A save is due as soon as the current one ends. */
  private due = false;
  private timer: number | null = null;
  /** No saving at all (read-only project, or between projects). */
  paused = false;

  constructor(
    private readonly save: () => Promise<void>,
    public debounceMs: number,
    private readonly timers: Timers = browserTimers,
  ) {}

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  get isSaving(): boolean {
    return this.saving;
  }

  /** Something changed (layers, canvases, arrows, block settings… or a stroke's tiles). */
  changed(): void {
    this.dirty = true;
    this.restartDebounce();
  }

  strokeStarted(): void {
    this.strokeInProgress = true;
    this.cancelDebounce();
  }

  /** A stroke ended and was committed (its change is reported through `changed` too). */
  strokeEnded(): void {
    this.strokeInProgress = false;
    this.dirty = true;
    this.unsavedStrokes++;
    if (this.unsavedStrokes >= 2) this.saveNow();
    else this.restartDebounce();
  }

  /** A stroke was cancelled: nothing changed. */
  strokeCancelled(): void {
    this.strokeInProgress = false;
    if (this.dirty) this.restartDebounce();
  }

  /** Save now if anything is unsaved (page hidden, page closing, before switching projects). */
  flush(): void {
    if (this.dirty) this.saveNow();
  }

  /** Resolves when nothing is unsaved and no save is running (or saving failed). */
  async settle(): Promise<void> {
    this.flush();
    while (this.saving || this.due) await new Promise((resolve) => this.timers.set(() => resolve(undefined), 10));
  }

  private restartDebounce(): void {
    this.cancelDebounce();
    if (this.strokeInProgress || this.paused) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (!this.strokeInProgress) this.saveNow();
    }, this.debounceMs);
  }

  private cancelDebounce(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private saveNow(): void {
    this.cancelDebounce();
    if (this.paused) return;
    if (this.saving) {
      this.due = true;
      return;
    }
    this.saving = true;
    this.due = false;
    this.dirty = false;
    const strokes = this.unsavedStrokes;
    this.unsavedStrokes = 0;
    this.save()
      .catch(() => {
        // The saver reports the error; the changes are still unsaved and are retried after the next debounce.
        this.dirty = true;
        this.unsavedStrokes += strokes;
      })
      .finally(() => {
        this.saving = false;
        if (this.due) this.saveNow();
        else if (this.dirty && this.timer === null) this.restartDebounce();
      });
  }
}
