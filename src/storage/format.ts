import type { BlendMode, RGB } from '../document/blend';
import type { InheritedBlock } from '../document/inheritedBlock';
import type { ObjectHash } from './objectCodec';
import { isObjectHash } from './objectCodec';

/**
 * The saved project format (Phase 4). Everything here is plain JSON data.
 *
 *   head (IndexedDB) ──► root manifest ──► canvas record ──► tiles
 *   (working copy,       (canvases in      (one canvas:      (content-
 *    versions)            z-order)          layers, block,    addressed)
 *                                           previews)
 *
 * - A **root manifest** describes the whole project at one moment. It is
 *   written once under a new name and never changed. Versions are root
 *   manifests, so they are always project-level.
 * - A **canvas record** describes one canvas. It is a content-addressed
 *   object like a tile, so a save writes records only for canvases that
 *   changed, and versions share the records of unchanged canvases.
 * - Tile maps use "tx,ty" keys (tile column and row), so the format doesn't
 *   depend on the in-memory tile key encoding.
 *
 * `formatVersion` is in every manifest, record and export file; older data is
 * brought up to date by `migrations.ts` when it is read.
 */

export const FORMAT_VERSION = 1;

export type ManifestId = string;
export type VersionId = string;
export type ProjectId = string;

/** "tx,ty" → hash of the tile's content. Missing keys are transparent. */
export type TileMap = Record<string, ObjectHash>;

export interface RootManifest {
  formatVersion: number;
  id: ManifestId;
  /** ms since the epoch. */
  createdAt: number;
  /** Back to front. */
  canvases: { id: string; record: ObjectHash }[];
  /** Next canvas number, so new canvas ids never repeat old ones. */
  canvasCounter: number;
  activeCanvasId: string | null;
  /** The camera when saved (absent: fit everything on open). */
  view?: { scale: number; rotation: number; tx: number; ty: number };
}

export interface LayerRecord {
  id: string;
  name: string;
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
  tiles: TileMap;
}

/** A saved preview level of the canvas's composite (premultiplied tiles, like layer tiles). */
export interface PreviewRecord {
  level: number;
  tiles: TileMap;
}

export interface CanvasRecord {
  formatVersion: number;
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paper: RGB;
  paperVisible: boolean;
  /** Next layer number on this canvas, so layer ids never repeat. */
  layerCounter: number;
  /** Bottom to top. */
  layers: LayerRecord[];
  inherited: InheritedBlock | null;
  previews: PreviewRecord[];
}

export type VersionKind = 'manual' | 'auto';
export type AutoReason = 'session-ended' | 'active-time' | 'before-restore';

export interface VersionEntry {
  id: VersionId;
  manifestId: ManifestId;
  name: string;
  createdAt: number;
  kind: VersionKind;
  reason?: AutoReason;
  pinned: boolean;
  /** File name of the workspace thumbnail (PNG) in `thumbnails/`, if one was made. */
  thumbnail: string | null;
}

/**
 * The small record that says what the project *is*. Changing it is the
 * commit point of every save: it is replaced in one IndexedDB transaction.
 */
export interface HeadRecord {
  projectId: ProjectId;
  /** The working copy (continuous autosave). */
  working: ManifestId;
  /** Oldest first. */
  versions: VersionEntry[];
  /** Active editing time since the last automatic "active time" version (ms). */
  activeMsSinceVersion: number;
  updatedAt: number;
}

export interface ProjectInfo {
  id: ProjectId;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  /** Bytes the project's folder takes (kept up to date by saves and GC). */
  sizeBytes: number;
}

// --- where things live in a project's folder ---------------------------------

export type ObjectKind = 'tile' | 'record';

const OBJECT_DIRS: Record<ObjectKind, string> = { tile: 'tiles', record: 'records' };

/** Objects are spread over 256 subfolders by their first two hex digits, so no folder gets huge. */
export function objectPath(kind: ObjectKind, hash: ObjectHash): string {
  return `${OBJECT_DIRS[kind]}/${hash.slice(0, 2)}/${hash}`;
}

export function objectDir(kind: ObjectKind): string {
  return OBJECT_DIRS[kind];
}

export function manifestPath(id: ManifestId): string {
  return `manifests/${id}.json`;
}

export function thumbnailPath(name: string): string {
  return `thumbnails/${name}`;
}

export function tileMapKey(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

export function parseTileMapKey(key: string): { tx: number; ty: number } {
  const match = /^(\d+),(\d+)$/.exec(key);
  if (!match) throw new FormatError(`bad tile key "${key}"`);
  return { tx: Number(match[1]), ty: Number(match[2]) };
}

/** A new random id with a readable prefix, e.g. "m-…" for a manifest. */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// --- every hash a manifest's records use ------------------------------------

/** Tile hashes used by a canvas record (layers and previews). */
export function recordTileHashes(record: CanvasRecord, into = new Set<ObjectHash>()): Set<ObjectHash> {
  for (const layer of record.layers) for (const hash of Object.values(layer.tiles)) into.add(hash);
  for (const preview of record.previews) for (const hash of Object.values(preview.tiles)) into.add(hash);
  return into;
}

// --- validation (for loading and importing) ---------------------------------

/** Saved data that isn't in the expected shape. */
export class FormatError extends Error {
  constructor(message: string) {
    super(`Invalid project data: ${message}`);
    this.name = 'FormatError';
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FormatError(message);
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkTileMap(map: unknown, where: string): void {
  check(isObject(map), `${where}: tiles must be an object`);
  for (const [key, hash] of Object.entries(map)) {
    parseTileMapKey(key);
    check(isObjectHash(hash), `${where}: tile ${key} has a bad hash`);
  }
}

/** Checks a root manifest of the current format (after migration). */
export function validateManifest(value: unknown): RootManifest {
  check(isObject(value), 'manifest is not an object');
  check(value.formatVersion === FORMAT_VERSION, `manifest format ${String(value.formatVersion)}`);
  check(isString(value.id), 'manifest id');
  check(isNumber(value.createdAt), 'manifest createdAt');
  check(Array.isArray(value.canvases), 'manifest canvases');
  const ids = new Set<string>();
  for (const c of value.canvases as unknown[]) {
    check(isObject(c) && isString(c.id) && isObjectHash(c.record), 'manifest canvas entry');
    check(!ids.has(c.id), `canvas ${c.id} listed twice`);
    ids.add(c.id);
  }
  check(isNumber(value.canvasCounter), 'manifest canvasCounter');
  check(value.activeCanvasId === null || isString(value.activeCanvasId), 'manifest activeCanvasId');
  return value as unknown as RootManifest;
}

/** Checks a canvas record of the current format (after migration). */
export function validateRecord(value: unknown): CanvasRecord {
  check(isObject(value), 'record is not an object');
  check(value.formatVersion === FORMAT_VERSION, `record format ${String(value.formatVersion)}`);
  const where = `canvas ${String(value.id)}`;
  check(isString(value.id) && isString(value.name), `${where}: id and name`);
  for (const k of ['x', 'y', 'width', 'height', 'layerCounter'] as const) check(isNumber(value[k]), `${where}: ${k}`);
  check(Array.isArray(value.paper) && value.paper.length === 3 && value.paper.every(isNumber), `${where}: paper`);
  check(typeof value.paperVisible === 'boolean', `${where}: paperVisible`);
  check(Array.isArray(value.layers) && value.layers.length > 0, `${where}: layers`);
  for (const layer of value.layers as unknown[]) {
    check(isObject(layer) && isString(layer.id) && isString(layer.name), `${where}: layer`);
    check(isNumber(layer.opacity) && typeof layer.visible === 'boolean', `${where}: layer ${layer.id} settings`);
    check(layer.blendMode === 'normal' || layer.blendMode === 'multiply', `${where}: layer ${layer.id} blend mode`);
    checkTileMap(layer.tiles, `${where}, layer ${layer.id}`);
  }
  check(value.inherited === null || isObject(value.inherited), `${where}: inherited block`);
  if (isObject(value.inherited)) {
    const source = value.inherited.source;
    check(isObject(source) && ['linked', 'empty', 'missing'].includes(source.kind as string), `${where}: block source`);
  }
  check(Array.isArray(value.previews), `${where}: previews`);
  for (const p of value.previews as unknown[]) {
    check(isObject(p) && isNumber(p.level), `${where}: preview`);
    checkTileMap(p.tiles, `${where}, preview`);
  }
  return value as unknown as CanvasRecord;
}
