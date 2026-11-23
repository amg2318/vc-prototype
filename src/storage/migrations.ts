import { FORMAT_VERSION, FormatError } from './format';

/**
 * Bringing saved data from older formats up to date.
 *
 * One migration per version step (n → n + 1), applied in order when a
 * manifest or canvas record is read, so a project saved by any older version
 * of the app still opens. Migrations work on plain JSON and never touch
 * tiles: tile content is raw premultiplied RGBA, which no step changes.
 *
 * Saved data is never rewritten in place: a migrated project is written in
 * the current format by its next save, under new names, like any other save.
 */

type Json = Record<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  description: string;
  manifest(value: Json): Json;
  record(value: Json): Json;
}

/**
 * Format 0 → 1. **A test migration:** format 0 was a draft of the Phase 4
 * format, written by hand for this test and never shipped. It shows how a
 * real step looks:
 *  - tile maps were keyed by the in-memory tile key (`ty * 16 + tx`, which
 *    depends on the 4096 px canvas limit) instead of "tx,ty";
 *  - a layer's blend mode was called `blend`;
 *  - records had no `previews`, and manifests had no `canvasCounter`.
 */
const DRAFT_TILES_PER_ROW = 16;

const formatZeroToOne: Migration = {
  from: 0,
  to: 1,
  description: 'draft format: integer tile keys → "tx,ty"; layer `blend` → `blendMode`; add previews and canvasCounter',
  manifest(value) {
    const canvases = (value.canvases as { id: string }[]) ?? [];
    const highest = Math.max(0, ...canvases.map((c) => Number(/(\d+)$/.exec(c.id)?.[1] ?? 0)));
    return { ...value, formatVersion: 1, canvasCounter: value.canvasCounter ?? highest };
  },
  record(value) {
    const layers = (value.layers as Json[]).map(({ blend, tiles, ...layer }) => ({
      ...layer,
      blendMode: blend ?? 'normal',
      tiles: Object.fromEntries(
        Object.entries(tiles as Record<string, string>).map(([key, hash]) => {
          const n = Number(key);
          return [`${n % DRAFT_TILES_PER_ROW},${Math.floor(n / DRAFT_TILES_PER_ROW)}`, hash];
        }),
      ),
    }));
    return { ...value, formatVersion: 1, layers, previews: value.previews ?? [] };
  },
};

/** Every step, in order. Add the next one here when the format changes. */
export const MIGRATIONS: readonly Migration[] = [formatZeroToOne];

function migrate(value: unknown, what: 'manifest' | 'record', migrations: readonly Migration[]): unknown {
  if (typeof value !== 'object' || value === null) throw new FormatError(`${what} is not an object`);
  let current = value as Json;
  let version = typeof current.formatVersion === 'number' ? current.formatVersion : 0;
  if (version > FORMAT_VERSION) {
    throw new FormatError(`this ${what} was saved by a newer version of the app (format ${version}); please update`);
  }
  while (version < FORMAT_VERSION) {
    const step = migrations.find((m) => m.from === version);
    if (!step) throw new FormatError(`no migration from format ${version}`);
    current = step[what](current);
    version = step.to;
  }
  return current;
}

export function migrateManifest(value: unknown, migrations = MIGRATIONS): unknown {
  return migrate(value, 'manifest', migrations);
}

export function migrateRecord(value: unknown, migrations = MIGRATIONS): unknown {
  return migrate(value, 'record', migrations);
}
