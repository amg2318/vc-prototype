import { describe, expect, it } from 'vitest';
import { AutosaveScheduler, type Timers } from './autosaveScheduler';

/** Timers driven by hand: `advance(ms)` runs whatever falls due. */
class FakeClock implements Timers {
  now = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): number {
    const handle = this.next++;
    this.pending.set(handle, { at: this.now + ms, fn });
    return handle;
  }
  clear(handle: number): void {
    this.pending.delete(handle);
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = until;
  }
}

/** A save that finishes when the test says so. */
function setup(debounceMs = 1500) {
  const clock = new FakeClock();
  const saves: { finish(ok?: boolean): Promise<void> }[] = [];
  const scheduler = new AutosaveScheduler(
    () =>
      new Promise<void>((resolve, reject) => {
        saves.push({
          finish: async (ok = true) => {
            if (ok) resolve();
            else reject(new Error('disk full'));
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      }),
    debounceMs,
    clock,
  );
  return { clock, saves, scheduler };
}

describe('AutosaveScheduler', () => {
  it('saves once the debounce runs out after a change', () => {
    const { clock, saves, scheduler } = setup();
    scheduler.changed();
    clock.advance(1000);
    scheduler.changed(); // restarts the debounce
    clock.advance(1000);
    expect(saves).toHaveLength(0);
    clock.advance(600);
    expect(saves).toHaveLength(1);
  });

  it('does not save while a stroke is in progress', () => {
    const { clock, saves, scheduler } = setup();
    scheduler.changed();
    scheduler.strokeStarted();
    clock.advance(5000);
    expect(saves).toHaveLength(0);
    scheduler.strokeEnded();
    clock.advance(1500);
    expect(saves).toHaveLength(1);
  });

  it('saves at once when a second stroke ends unsaved, so at most one stroke is ever unsaved', () => {
    const { clock, saves, scheduler } = setup();
    scheduler.strokeStarted();
    scheduler.strokeEnded();
    clock.advance(300);
    scheduler.strokeStarted();
    scheduler.strokeEnded();
    expect(saves).toHaveLength(1); // no waiting for the debounce
  });

  it('saves at once when flushed (page hidden), and not at all when nothing changed', () => {
    const { saves, scheduler } = setup();
    scheduler.flush();
    expect(saves).toHaveLength(0);
    scheduler.changed();
    scheduler.flush();
    expect(saves).toHaveLength(1);
  });

  it('runs one save at a time; changes during a save are saved right after it when due', async () => {
    const { saves, scheduler } = setup();
    scheduler.changed();
    scheduler.flush();
    scheduler.strokeEnded();
    scheduler.strokeEnded(); // due now, but a save is running
    expect(saves).toHaveLength(1);
    await saves[0]!.finish();
    expect(saves).toHaveLength(2);
  });

  it('changes during a save that are not yet due wait for the debounce', async () => {
    const { clock, saves, scheduler } = setup();
    scheduler.changed();
    scheduler.flush();
    scheduler.changed();
    await saves[0]!.finish();
    expect(saves).toHaveLength(1);
    clock.advance(1500);
    expect(saves).toHaveLength(2);
  });

  it('keeps changes unsaved after a failed save and tries again', async () => {
    const { clock, saves, scheduler } = setup();
    scheduler.strokeEnded();
    scheduler.flush();
    await saves[0]!.finish(false);
    expect(scheduler.hasUnsavedChanges).toBe(true);
    clock.advance(1500);
    expect(saves).toHaveLength(2);
  });

  it('does nothing while paused (read-only project)', () => {
    const { clock, saves, scheduler } = setup();
    scheduler.paused = true;
    scheduler.changed();
    scheduler.strokeEnded();
    scheduler.strokeEnded();
    scheduler.flush();
    clock.advance(5000);
    expect(saves).toHaveLength(0);
  });
});
