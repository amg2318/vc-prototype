import { manifestPath, recordTileHashes, thumbnailPath } from './format';
import type { ObjectHash } from './objectCodec';
import type { ProjectStore } from './projectStore';

/**
 * Garbage collection of one project's folder: mark and sweep, in the
 * storage worker. Saving never deletes tiles or records (several manifests
 * may share them); this removes the ones nothing refers to any more.
 *
 *  1. `begin`: from now on every object written is recorded (`touched`) and
 *     never swept, so saves can carry on during the collection.
 *  2. `mark` (one step, with saves held back): every object reachable from
 *     the head (working copy and versions), plus the hashes the app still
 *     holds (`live`: undo history, evicted tiles, previews not committed
 *     yet). The app collects `live` after `begin` has answered, so a tile
 *     written before `begin` is either in `live` or no longer needed.
 *  3. `sweep`: in short steps (each holds back saves only for `budgetMs`),
 *     list the folder and delete every object neither marked nor touched,
 *     and every manifest and thumbnail the head no longer uses.
 *  4. `finish`: count what is left and record it as the project's size.
 *
 * Stopping before `finish` is safe: nothing is deleted that is in use, and
 * the next collection starts again.
 */

export interface SweepProgress {
  done: boolean;
  removedFiles: number;
  removedBytes: number;
}

export class GarbageCollector {
  private marked: Set<ObjectHash> | null = null;
  /** Folders still to list, then files still to look at. */
  private readonly dirs = ['tiles', 'records', 'manifests', 'thumbnails'];
  private readonly files: { path: string; size: number }[] = [];
  private removedFiles = 0;
  private removedBytes = 0;

  constructor(private readonly store: ProjectStore) {}

  begin(): Promise<void> {
    return this.store.exclusive(async () => {
      this.store.touched = new Set();
    });
  }

  /** Returns how many objects are in use. */
  mark(live: readonly ObjectHash[]): Promise<number> {
    return this.store.exclusive(async () => {
      const marked = new Set<ObjectHash>(live);
      const head = this.store.head;
      if (head) {
        const manifests = new Set([head.working, ...head.versions.map((v) => v.manifestId)]);
        for (const id of manifests) {
          // If a manifest can't be read, marking fails and nothing is deleted.
          const manifest = await this.store.readManifest(id);
          for (const entry of manifest.canvases) {
            marked.add(entry.record);
            recordTileHashes(await this.store.readRecord(entry.record), marked);
          }
        }
      }
      this.marked = marked;
      return marked.size;
    });
  }

  /** Delete unused files for about `budgetMs`. Call again until `done`. */
  sweep(budgetMs: number): Promise<SweepProgress> {
    return this.store.exclusive(async () => {
      if (!this.marked || !this.store.touched) throw new Error('Garbage collection: mark first');
      const until = performance.now() + budgetMs;
      do {
        const file = this.files.pop();
        if (file) {
          if (this.unused(file.path)) {
            await this.store.files.remove(file.path);
            this.store.forgetVerified(file.path);
            this.store.adjustSize(-file.size);
            this.removedFiles++;
            this.removedBytes += file.size;
          }
          continue;
        }
        const dir = this.dirs.pop();
        if (dir === undefined) break;
        for (const entry of await this.store.files.list(dir)) {
          const path = `${dir}/${entry.name}`;
          if (entry.kind === 'dir') this.dirs.push(path);
          else this.files.push({ path, size: entry.size });
        }
      } while (performance.now() < until); // at least one item per step, so every step makes progress
      return { done: this.files.length === 0 && this.dirs.length === 0, removedFiles: this.removedFiles, removedBytes: this.removedBytes };
    });
  }

  /** Record the project's real size and stop recording writes. Returns the size. */
  finish(): Promise<number> {
    return this.store.exclusive(async () => {
      let size = 0;
      const dirs = [''];
      while (dirs.length > 0) {
        const dir = dirs.pop()!;
        for (const entry of await this.store.files.list(dir)) {
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.kind === 'dir') dirs.push(path);
          else size += entry.size;
        }
      }
      this.store.touched = null;
      await this.store.setSize(size);
      return size;
    });
  }

  /** Stop without finishing (nothing in use has been deleted). */
  cancel(): void {
    this.store.touched = null;
  }

  private unused(path: string): boolean {
    const [top, ...rest] = path.split('/');
    const name = rest.at(-1)!;
    if (top === 'tiles' || top === 'records') {
      return !this.marked!.has(name) && !this.store.touched!.has(name);
    }
    const head = this.store.head;
    if (!head) return false;
    if (top === 'manifests') {
      const used = new Set([head.working, ...head.versions.map((v) => v.manifestId)].map(manifestPath));
      return !used.has(path);
    }
    if (top === 'thumbnails') {
      const used = new Set(head.versions.flatMap((v) => (v.thumbnail ? [thumbnailPath(v.thumbnail)] : [])));
      return !used.has(path);
    }
    return false;
  }
}
