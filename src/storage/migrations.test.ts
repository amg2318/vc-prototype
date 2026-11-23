import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, validateManifest, validateRecord } from './format';
import { migrateManifest, migrateRecord } from './migrations';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A canvas record in format 0, the hand-written draft format (see migrations.ts). */
const draftRecord = {
  formatVersion: 0,
  id: 'canvas-3',
  name: 'Old canvas',
  x: 10,
  y: 20,
  width: 2048,
  height: 2048,
  paper: [1, 1, 1],
  paperVisible: true,
  layerCounter: 1,
  layers: [{ id: 'canvas-3:layer-1', name: 'Layer 1', opacity: 0.5, visible: true, blend: 'multiply', tiles: { '0': HASH_A, '33': HASH_B } }],
  inherited: null,
};

describe('migrations', () => {
  it('bring a format-0 record up to date', () => {
    const record = validateRecord(migrateRecord(draftRecord));
    expect(record.formatVersion).toBe(FORMAT_VERSION);
    expect(record.layers[0]!.blendMode).toBe('multiply');
    // Key 33 = row 2, column 1 with 16 tiles per row.
    expect(record.layers[0]!.tiles).toEqual({ '0,0': HASH_A, '1,2': HASH_B });
    expect(record.previews).toEqual([]);
  });

  it('bring a format-0 manifest up to date (canvas counter from the ids)', () => {
    const manifest = validateManifest(
      migrateManifest({ id: 'm-1', createdAt: 1, canvases: [{ id: 'canvas-3', record: HASH_A }], activeCanvasId: null }),
    );
    expect(manifest.canvasCounter).toBe(3);
  });

  it('leave current data unchanged', () => {
    const current = { ...draftRecord, formatVersion: FORMAT_VERSION };
    expect(migrateRecord(current)).toBe(current);
  });

  it('refuse data from a newer version of the app', () => {
    expect(() => migrateRecord({ ...draftRecord, formatVersion: FORMAT_VERSION + 1 })).toThrow(/newer version/);
  });

  it('report a missing step', () => {
    expect(() => migrateRecord({ ...draftRecord, formatVersion: -1 }, [])).toThrow(/no migration/);
  });
});

describe('validation', () => {
  it('rejects records with bad tile keys or hashes', () => {
    const good = validateRecord(migrateRecord(draftRecord));
    const badKey = { ...good, layers: [{ ...good.layers[0]!, tiles: { x: HASH_A } }] };
    const badHash = { ...good, layers: [{ ...good.layers[0]!, tiles: { '0,0': 'nope' } }] };
    expect(() => validateRecord(badKey)).toThrow(/tile key/);
    expect(() => validateRecord(badHash)).toThrow(/bad hash/);
  });

  it('rejects a manifest listing a canvas twice', () => {
    const entry = { id: 'c', record: HASH_A };
    expect(() =>
      validateManifest({ formatVersion: FORMAT_VERSION, id: 'm', createdAt: 0, canvases: [entry, entry], canvasCounter: 1, activeCanvasId: null }),
    ).toThrow(/twice/);
  });
});
