import type { HeadRecord, ProjectInfo } from './format';
import type { BlobStore, Catalog } from './stores';

/**
 * Test helpers: storage that "dies" at a chosen step, the way the app does
 * when Safari is force-closed. Not used by the app.
 */

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}

/**
 * Counts the steps that change storage. At step `crashAt` (0-based) the
 * process dies: that step is cut short (a file write leaves half the bytes,
 * as a torn write would; a catalog transaction doesn't happen, as IndexedDB
 * guarantees) and every later call fails.
 */
export class CrashSwitch {
  steps = 0;
  dead = false;

  constructor(readonly crashAt = Infinity) {}

  /** Call before each step that changes storage. Returns true if this is the step that dies. */
  step(): boolean {
    this.alive();
    if (this.steps++ === this.crashAt) {
      this.dead = true;
      return true;
    }
    return false;
  }

  alive(): void {
    if (this.dead) throw new SimulatedCrash();
  }
}

export function crashingBlobStore(inner: BlobStore, crash: CrashSwitch): BlobStore {
  return {
    read: async (path) => (crash.alive(), inner.read(path)),
    list: async (dir) => (crash.alive(), inner.list(dir)),
    write: async (path, bytes) => {
      if (crash.step()) {
        await inner.write(path, bytes.subarray(0, Math.floor(bytes.byteLength / 2))); // torn write
        throw new SimulatedCrash();
      }
      await inner.write(path, bytes);
    },
    remove: async (path) => {
      if (crash.step()) throw new SimulatedCrash();
      await inner.remove(path);
    },
    removeDir: async (dir) => {
      if (crash.step()) throw new SimulatedCrash();
      await inner.removeDir(dir);
    },
  };
}

export function crashingCatalog(inner: Catalog, crash: CrashSwitch): Catalog {
  const changing =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      if (crash.step()) throw new SimulatedCrash(); // transactions are all or nothing
      await fn(...args);
    };
  return {
    projects: async () => (crash.alive(), inner.projects()),
    project: async (id) => (crash.alive(), inner.project(id)),
    head: async (id) => (crash.alive(), inner.head(id)),
    putProject: changing((info: ProjectInfo) => inner.putProject(info)),
    commitHead: changing((head: HeadRecord, info?: ProjectInfo) => inner.commitHead(head, info)),
    deleteProject: changing((id: string) => inner.deleteProject(id)),
  };
}
