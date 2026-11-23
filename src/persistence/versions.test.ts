import { describe, expect, it } from 'vitest';
import type { HeadRecord } from '../storage/format';
import { ActiveTime, addVersionEdit, newVersion, workingCopyUnversioned } from './versions';

const head = (working: string, manifests: string[]): HeadRecord => ({
  projectId: 'p',
  working,
  versions: manifests.map((m, i) => ({ id: `v${i}`, manifestId: m, name: m, createdAt: 0, kind: 'manual', pinned: false, thumbnail: null })),
  activeMsSinceVersion: 5,
  updatedAt: 0,
});

describe('versions', () => {
  it('adds the new version first and resets active time', () => {
    const edit = addVersionEdit(head('m2', ['m1']), newVersion('manual', undefined, 100, null, 't.png'), 100, { keepLatest: 10, dailyForDays: 30 });
    expect(edit.versions!.map((v) => v.manifestId)).toEqual([null, 'm1']);
    expect(edit.activeMsSinceVersion).toBe(0);
  });

  it('applies retention to automatic versions when adding one', () => {
    const many = head('m', []);
    many.versions = Array.from({ length: 3 }, (_, i) => ({ ...newVersion('auto', 'active-time', 1000 - i, `m${i}`, null), manifestId: `m${i}` }));
    const edit = addVersionEdit(many, newVersion('auto', 'active-time', 2000, null, null), 2000, { keepLatest: 2, dailyForDays: 30 });
    expect(edit.versions).toHaveLength(2);
  });

  it('knows when the working copy has changes no version holds', () => {
    expect(workingCopyUnversioned(head('m2', ['m1']))).toBe(true);
    expect(workingCopyUnversioned(head('m1', ['m1']))).toBe(false);
    expect(workingCopyUnversioned(null)).toBe(false);
  });

  it('counts active time between inputs, capping long pauses', () => {
    const t = new ActiveTime(0, 1000);
    t.input(0);
    t.input(400);
    t.input(10_000); // a long pause counts as the window
    expect(t.ms).toBe(1400);
  });
});
