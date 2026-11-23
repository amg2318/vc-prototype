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
  release(): void;
}

/** Take the project's lock if no other tab holds it; null if one does. */
export function tryLockProject(id: ProjectId): Promise<HeldLock | null> {
  if (!('locks' in navigator)) return Promise.resolve({ release() {} });
  return new Promise((resolve) => {
    void navigator.locks.request(lockName(id), { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      // Hold the lock until release() is called.
      return new Promise<void>((release) => resolve({ release: () => release() }));
    });
  });
}

/** True if another tab (or this one) holds the project's lock. */
export async function isProjectLocked(id: ProjectId): Promise<boolean> {
  if (!('locks' in navigator)) return false;
  const state = await navigator.locks.query();
  return (state.held ?? []).some((l) => l.name === lockName(id));
}
