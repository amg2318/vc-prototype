import type { HeadRecord, ProjectId, ProjectInfo } from './format';
import type { Catalog } from './stores';

/**
 * Catalog in IndexedDB: the project list and each project's head record.
 *
 * `commitHead` writes the head (and the project's info) in one readwrite
 * transaction with strict durability, so it is the atomic, durable commit
 * point of every save: after a crash, either the old head or the new one is
 * there.
 */
const DB_NAME = 'vc-storage';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const HEADS = 'heads';

export class IdbCatalog implements Catalog {
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IdbCatalog> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(HEADS)) db.createObjectStore(HEADS, { keyPath: 'projectId' });
      };
      request.onsuccess = () => resolve(new IdbCatalog(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  projects(): Promise<ProjectInfo[]> {
    return this.run([PROJECTS], 'readonly', (t) => t.objectStore(PROJECTS).getAll() as IDBRequest<ProjectInfo[]>);
  }

  async project(id: ProjectId): Promise<ProjectInfo | null> {
    return (await this.run([PROJECTS], 'readonly', (t) => t.objectStore(PROJECTS).get(id) as IDBRequest<ProjectInfo | undefined>)) ?? null;
  }

  async putProject(info: ProjectInfo): Promise<void> {
    await this.run([PROJECTS], 'readwrite', (t) => t.objectStore(PROJECTS).put(info));
  }

  async head(id: ProjectId): Promise<HeadRecord | null> {
    return (await this.run([HEADS], 'readonly', (t) => t.objectStore(HEADS).get(id) as IDBRequest<HeadRecord | undefined>)) ?? null;
  }

  async commitHead(head: HeadRecord, info?: ProjectInfo): Promise<void> {
    await this.run([HEADS, PROJECTS], 'readwrite', (t) => {
      if (info) t.objectStore(PROJECTS).put(info);
      return t.objectStore(HEADS).put(head);
    });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.run([HEADS, PROJECTS], 'readwrite', (t) => {
      t.objectStore(HEADS).delete(id);
      return t.objectStore(PROJECTS).delete(id);
    });
  }

  /** Run one transaction; resolves with the last request's result once the transaction has committed. */
  private run<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(stores, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
      const request = body(transaction);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
