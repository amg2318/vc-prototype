/**
 * "Delete all data on this device" (for testing): every project, version
 * and setting this app stored in this browser. The storage worker keeps
 * project files open while it runs, so the reset is only asked for here,
 * then carried out by the next page load, before the worker starts.
 *
 * Only this app's own data is deleted. Every app served from the same
 * address (e.g. all of one user's GitHub Pages sites) shares one storage
 * space, so other apps' files, databases and settings are left alone. The
 * offline copy of the app itself (the service worker's cache) is kept.
 */

const PENDING_KEY = 'vc-reset-pending';
const FOLDER = 'projects'; // the app's only top-level folder in OPFS, see stores.ts
const DATABASE = 'vc-storage'; // see idbCatalog.ts
const PROJECT_LOCK_PREFIX = 'vc-project-'; // see projectLock.ts
/** Every key this app keeps in localStorage and sessionStorage starts with this. */
const SETTINGS_PREFIX = 'vc-';

/** Ask for a reset and reload the page to carry it out. */
export function requestReset(): void {
  localStorage.setItem(PENDING_KEY, '1');
  location.reload();
}

/**
 * At launch, before anything opens storage: carry out a requested reset.
 * Returns null if none was requested, else a message saying how it went.
 */
export async function resetIfRequested(): Promise<string | null> {
  if (localStorage.getItem(PENDING_KEY) === null) return null;
  localStorage.removeItem(PENDING_KEY);
  // Another tab with a project open still has its files and database open.
  if ('locks' in navigator) {
    const { held = [] } = await navigator.locks.query();
    if (held.some((lock) => lock.name?.startsWith(PROJECT_LOCK_PREFIX))) {
      return 'Nothing was deleted: the app is open in another tab. Close it there, then try again.';
    }
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(FOLDER, { recursive: true }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    });
    await deleteDatabase(DATABASE);
    removeSettings(localStorage);
    removeSettings(sessionStorage);
    return 'All projects, versions and settings on this device were deleted.';
  } catch (error) {
    return `The reset did not finish: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Remove this app's keys only. */
function removeSettings(storage: Storage): void {
  const ours: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(SETTINGS_PREFIX)) ours.push(key);
  }
  for (const key of ours) storage.removeItem(key);
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete the project list'));
    request.onblocked = () => reject(new Error('the project list is still open in another tab'));
  });
}
