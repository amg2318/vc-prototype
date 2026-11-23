import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  FORMAT_VERSION,
  FormatError,
  manifestPath,
  newId,
  objectPath,
  recordTileHashes,
  thumbnailPath,
  validateManifest,
  validateRecord,
  type CanvasRecord,
  type HeadRecord,
  type ManifestId,
  type RootManifest,
  type VersionEntry,
} from './format';
import { migrateManifest, migrateRecord } from './migrations';
import { decodeAndVerify, encodeJson, type ObjectHash } from './objectCodec';
import type { ProjectStore } from './projectStore';

/**
 * The project file (`.vcproj`, a placeholder name): a zip holding
 *
 *   project.json          what is in it (format version, name, working copy, versions)
 *   manifests/<id>.json   the root manifests it needs
 *   records/<hash>        canvas records, exactly as stored (compressed, checksummed)
 *   tiles/<hash>          tiles (layers and previews), exactly as stored
 *   thumbnails/<name>     version thumbnails (PNG)
 *
 * Without history it holds only the working copy. Objects are already
 * compressed, so the zip stores them as they are.
 *
 * Importing never trusts the file: every path is checked, manifests and
 * records are migrated and validated, every object's hash is verified, and
 * everything referenced must be present. The result is always a new
 * project with new IDs.
 */

export const PROJECT_FILE_EXTENSION = '.vcproj';
export const PROJECT_FILE_TYPE = 'application/octet-stream';

interface ArchiveIndex {
  kind: 'vc-project';
  formatVersion: number;
  exportedAt: number;
  name: string;
  includesHistory: boolean;
  working: ManifestId;
  versions: VersionEntry[];
}

/** Every file in a project file must be under this size, and there may be at most this many (a damaged or hostile zip). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 500_000;

/** Write the open project as a project file. Run inside the store's lock, so no save changes it meanwhile. */
export async function exportArchive(store: ProjectStore, name: string, includeHistory: boolean): Promise<Uint8Array> {
  const head = store.head;
  if (!head) throw new Error('This project has not been saved yet');
  const versions = includeHistory ? head.versions : [];
  const manifestIds = new Set([head.working, ...versions.map((v) => v.manifestId)]);
  const zip: Zippable = {};
  const records = new Set<ObjectHash>();
  const tiles = new Set<ObjectHash>();
  for (const id of manifestIds) {
    const bytes = await store.files.read(manifestPath(id));
    if (!bytes) throw new Error(`Manifest ${id} is missing`);
    zip[`manifests/${id}.json`] = bytes;
    const manifest = await store.readManifest(id);
    for (const entry of manifest.canvases) {
      if (records.has(entry.record)) continue;
      records.add(entry.record);
      recordTileHashes(await store.readRecord(entry.record), tiles);
    }
  }
  for (const [kind, hashes] of [['record', records], ['tile', tiles]] as const) {
    for (const hash of hashes) {
      const bytes = await store.readStoredObject(kind, hash);
      if (!bytes) throw new Error(`The ${kind} ${hash.slice(0, 12)}… is missing`);
      zip[`${kind}s/${hash}`] = [bytes, { level: 0 }];
    }
  }
  for (const v of versions) {
    const bytes = v.thumbnail ? await store.files.read(thumbnailPath(v.thumbnail)) : null;
    if (bytes) zip[`thumbnails/${v.thumbnail}`] = [bytes, { level: 0 }];
  }
  const index: ArchiveIndex = { kind: 'vc-project', formatVersion: FORMAT_VERSION, exportedAt: Date.now(), name, includesHistory: includeHistory, working: head.working, versions };
  zip['project.json'] = strToU8(JSON.stringify(index, null, 2));
  return zipSync(zip);
}

/** A checked project file, ready to write as a new project. */
export interface ImportedProject {
  name: string;
  /** Files to write into the new project's folder, by path. */
  files: Map<string, Uint8Array>;
  /** The head, apart from the project id. */
  head: Omit<HeadRecord, 'projectId'>;
}

export async function readArchive(bytes: Uint8Array): Promise<ImportedProject> {
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (++count > MAX_FILES) throw new FormatError('The project file has too many files');
        if (file.originalSize > MAX_FILE_BYTES) throw new FormatError(`${file.name} is too large`);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError('This is not a project file (it is not a readable zip)');
  }
  for (const path of Object.keys(entries)) {
    if (!/^(project\.json|manifests\/m-[\w-]+\.json|(records|tiles)\/[0-9a-f]{64}|thumbnails\/[\w-]+\.png)$/.test(path) && !path.endsWith('/')) {
      throw new FormatError(`Unexpected file in the project file: ${path}`);
    }
  }
  const index = parseIndex(entries['project.json']);
  const files = new Map<string, Uint8Array>();

  // Records: verified, migrated and validated once each; a migrated record gets a new hash.
  const recordHashes = new Map<ObjectHash, ObjectHash>();
  const tilesNeeded = new Set<ObjectHash>();
  const importRecord = async (hash: ObjectHash): Promise<ObjectHash> => {
    const known = recordHashes.get(hash);
    if (known) return known;
    const stored = entries[`records/${hash}`];
    if (!stored) throw new FormatError(`Record ${hash.slice(0, 12)}… is missing from the project file`);
    const json: unknown = JSON.parse(new TextDecoder().decode(await decodeAndVerify(stored, hash)));
    const record: CanvasRecord = validateRecord(migrateRecord(json));
    recordTileHashes(record, tilesNeeded);
    let newHash = hash;
    let bytesToWrite = stored;
    if ((json as { formatVersion?: unknown }).formatVersion !== FORMAT_VERSION) {
      const encoded = await encodeJson(record); // migrated: stored in the current format
      newHash = encoded.hash;
      bytesToWrite = encoded.bytes;
    }
    files.set(objectPath('record', newHash), bytesToWrite);
    recordHashes.set(hash, newHash);
    return newHash;
  };

  // Manifests: new ids, migrated and validated, pointing at the imported records.
  const manifestIds = new Map<ManifestId, ManifestId>();
  const importManifest = async (id: ManifestId): Promise<ManifestId> => {
    const known = manifestIds.get(id);
    if (known) return known;
    const bytes = entries[`manifests/${id}.json`];
    if (!bytes) throw new FormatError(`Manifest ${id} is missing from the project file`);
    const manifest: RootManifest = validateManifest(migrateManifest(JSON.parse(strFromU8(bytes))));
    const canvases = [];
    for (const c of manifest.canvases) canvases.push({ id: c.id, record: await importRecord(c.record) });
    const fresh: RootManifest = { ...manifest, id: newId('m'), canvases };
    files.set(manifestPath(fresh.id), strToU8(JSON.stringify(fresh)));
    manifestIds.set(id, fresh.id);
    return fresh.id;
  };

  const working = await importManifest(index.working);
  const versions: VersionEntry[] = [];
  for (const v of index.versions) {
    const id = newId('v');
    const thumbnail = v.thumbnail ? entries[`thumbnails/${v.thumbnail}`] : undefined;
    const isPng = thumbnail !== undefined && thumbnail.length > 8 && thumbnail[0] === 137 && thumbnail[1] === 80;
    if (isPng) files.set(thumbnailPath(`${id}.png`), thumbnail);
    versions.push({ ...v, id, manifestId: await importManifest(v.manifestId), thumbnail: isPng ? `${id}.png` : null });
  }

  // Tiles: every one referenced must be present and match its hash.
  for (const hash of tilesNeeded) {
    const stored = entries[`tiles/${hash}`];
    if (!stored) throw new FormatError(`Tile ${hash.slice(0, 12)}… is missing from the project file`);
    await decodeAndVerify(stored, hash);
    files.set(objectPath('tile', hash), stored);
  }
  return { name: index.name, files, head: { working, versions, activeMsSinceVersion: 0, updatedAt: Date.now() } };
}

function parseIndex(bytes: Uint8Array | undefined): ArchiveIndex {
  if (!bytes) throw new FormatError('This is not a project file (project.json is missing)');
  let value: Partial<ArchiveIndex>;
  try {
    value = JSON.parse(strFromU8(bytes)) as Partial<ArchiveIndex>;
  } catch {
    throw new FormatError('project.json is not valid JSON');
  }
  if (value.kind !== 'vc-project') throw new FormatError('This is not a project file');
  if (typeof value.formatVersion !== 'number' || value.formatVersion < 0) throw new FormatError('project.json: formatVersion');
  if (value.formatVersion > FORMAT_VERSION) throw new FormatError('This project file was made by a newer version of the app');
  if (typeof value.working !== 'string') throw new FormatError('project.json: working copy');
  const versions = Array.isArray(value.versions) ? value.versions : [];
  for (const v of versions) {
    const ok =
      typeof v === 'object' && v !== null && typeof v.manifestId === 'string' && typeof v.name === 'string' && typeof v.createdAt === 'number' &&
      (v.kind === 'manual' || v.kind === 'auto') && typeof v.pinned === 'boolean';
    if (!ok) throw new FormatError('project.json: a version entry is malformed');
  }
  return {
    kind: 'vc-project',
    formatVersion: value.formatVersion,
    exportedAt: Number(value.exportedAt) || 0,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 200) : 'Imported project',
    includesHistory: value.includesHistory === true,
    working: value.working,
    versions: versions.map((v) => ({
      id: String(v.id), manifestId: v.manifestId, name: v.name.slice(0, 200), createdAt: v.createdAt, kind: v.kind, pinned: v.pinned,
      thumbnail: typeof v.thumbnail === 'string' && /^[\w-]+\.png$/.test(v.thumbnail) ? v.thumbnail : null,
      ...(v.reason === 'session-ended' || v.reason === 'active-time' || v.reason === 'before-restore' ? { reason: v.reason } : {}),
    })),
  };
}

