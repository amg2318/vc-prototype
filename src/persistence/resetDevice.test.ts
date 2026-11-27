import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetIfRequested } from './resetDevice';

/** A Storage stand-in holding the given keys. */
function storage(keys: string[]): Storage {
  const items = new Map(keys.map((k) => [k, '1']));
  return {
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
  };
}

/**
 * The browser storage a reset touches, shared with another app on the
 * same address (its OPFS folder, database and settings).
 */
function stubBrowser(lockNames: string[] = []) {
  const folders = new Set(['projects', 'other-app']);
  const databases = new Set(['vc-storage', 'other-app-db']);
  const local = storage(['vc-reset-pending', 'vc-last-project', 'vc-retention', 'vc-prototype.hud-collapsed', 'other-app-setting']);
  const session = storage(['vc-tab-notice', 'other-app-session']);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('navigator', {
    locks: { query: async () => ({ held: lockNames.map((name) => ({ name })) }) },
    storage: { getDirectory: async () => ({ removeEntry: async (name: string) => void folders.delete(name) }) },
  });
  vi.stubGlobal('indexedDB', {
    deleteDatabase(name: string) {
      const request: { onsuccess?: () => void } = {};
      setTimeout(() => {
        databases.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  });
  return { folders, databases, local, session };
}

describe('resetIfRequested', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deletes only this app’s folder, database and settings', async () => {
    const b = stubBrowser();
    expect(await resetIfRequested()).toMatch(/were deleted/);
    expect([...b.folders]).toEqual(['other-app']);
    expect([...b.databases]).toEqual(['other-app-db']);
    expect(b.local.length).toBe(1);
    expect(b.local.getItem('other-app-setting')).not.toBeNull();
    expect(b.session.length).toBe(1);
    expect(b.session.getItem('other-app-session')).not.toBeNull();
  });

  it('does nothing unless a reset was asked for', async () => {
    const b = stubBrowser();
    b.local.removeItem('vc-reset-pending');
    expect(await resetIfRequested()).toBeNull();
    expect(b.folders.size).toBe(2);
  });

  it('deletes nothing while another tab has a project open', async () => {
    const b = stubBrowser(['vc-project-p-1']);
    expect(await resetIfRequested()).toMatch(/another tab/);
    expect(b.folders.size).toBe(2);
    expect(b.local.getItem('vc-reset-pending')).toBeNull(); // not retried at every launch
  });
});
