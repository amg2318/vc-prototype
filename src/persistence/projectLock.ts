import type { ProjectId } from '../storage/format';

/**
 * One tab at a time may change a project. The tab that opens it first holds
 * a Web Lock named after it for as long as it has it open; a second tab
 * that can't get the lock opens the project read-only. Locks are released
 * by the browser when a tab closes or crashes, so a stale lock can't stay.
 *
 * Without the Web Locks API (very old browsers), every tab gets the lock:
 * the same as before Phase 4.
 */

const lockName = (id: ProjectId) => `vc-project-${id}`;

export interface HeldLock {
  readonly projectId: ProjectId;
  /** Let go of the lock; resolves once the browser has freed it (so it can be taken again at once). */
  release(): Promise<void>;
}

/** Take the project's lock if no other tab holds it; null if one does. */
export function tryLockProject(id: ProjectId): Promise<HeldLock | null> {
  if (!('locks' in navigator)) return Promise.resolve({ projectId: id, release: async () => undefined });
  return new Promise((resolve) => {
    // `request` settles once the lock is freed again.
    const freed: Promise<unknown> = navigator.locks.request(lockName(id), { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      // Hold the lock until release() is called.
      return new Promise<void>((letGo) =>
        resolve({
          projectId: id,
          release: async () => {
            letGo();
            await freed;
          },
        }),
      );
    });
  });
}

/**
 * Wait for the project's lock: resolves with it once no other tab holds it,
 * or null if `signal` aborts first (or the browser refuses the request).
 */
export function waitForProjectLock(id: ProjectId, signal: AbortSignal): Promise<HeldLock | null> {
  if (!('locks' in navigator)) return Promise.resolve({ projectId: id, release: async () => undefined });
  return new Promise((resolve) => {
    const freed: Promise<unknown> = navigator.locks
      .request(lockName(id), { signal }, () => {
        // Hold the lock until release() is called (or the tab closes).
        return new Promise<void>((letGo) =>
          resolve({
            projectId: id,
            release: async () => {
              letGo();
              await freed;
            },
          }),
        );
      })
      .catch(() => resolve(null)); // aborted before the lock was granted
  });
}

/**
 * Take the project's lock, waiting up to `waitMs` for another page to let go
 * (a page that is reloading or closing may still hold it for a moment).
 */
export async function lockProject(id: ProjectId, waitMs: number): Promise<HeldLock | null> {
  const now = await tryLockProject(id);
  if (now || waitMs <= 0) return now;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), waitMs);
  const lock = await waitForProjectLock(id, timeout.signal);
  clearTimeout(timer);
  return lock;
}

/** True if another tab (or this one) holds the project's lock. */
export async function isProjectLocked(id: ProjectId): Promise<boolean> {
  if (!('locks' in navigator)) return false;
  const state = await navigator.locks.query();
  return (state.held ?? []).some((l) => l.name === lockName(id));
}
