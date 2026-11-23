import { describe, expect, it } from 'vitest';
import type { VersionEntry } from '../storage/format';
import { applyRetention, versionsToKeep } from './retention';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A fixed "now": Wednesday 2026-11-25, 12:00 local time. */
const NOW = new Date(2026, 10, 25, 12).getTime();
const RULES = { keepLatest: 10, dailyForDays: 30 };

let counter = 0;
function version(ageMs: number, kind: VersionEntry['kind'] = 'auto', pinned = false): VersionEntry {
  counter++;
  return { id: `v${counter}`, manifestId: `m${counter}`, name: `v${counter}`, createdAt: NOW - ageMs, kind, pinned, thumbnail: null };
}

describe('retention', () => {
  it('keeps every manual and pinned version, however old or many', () => {
    const versions = [
      ...Array.from({ length: 30 }, (_, i) => version(i * HOUR, 'manual')),
      version(400 * DAY, 'manual'),
      version(500 * DAY, 'auto', true),
    ];
    expect(versionsToKeep(versions, NOW, RULES).size).toBe(versions.length);
  });

  it('keeps the newest 10 automatic versions, even on the same day', () => {
    const versions = Array.from({ length: 15 }, (_, i) => version(i * 10 * 60 * 1000)); // every 10 minutes today
    const kept = applyRetention(versions, NOW, RULES);
    expect(kept.map((v) => v.id)).toEqual(versions.slice(0, 10).map((v) => v.id));
  });

  it('then keeps one per day for 30 days (the newest of each day)', () => {
    const latest = Array.from({ length: 10 }, (_, i) => version(i * 60 * 1000)); // today
    const older = [version(2 * DAY), version(2 * DAY + 2 * HOUR), version(5 * DAY), version(5 * DAY + HOUR)];
    const kept = versionsToKeep([...latest, ...older], NOW, RULES);
    expect(kept.has(older[0]!.id)).toBe(true); // newest on day −2
    expect(kept.has(older[1]!.id)).toBe(false);
    expect(kept.has(older[2]!.id)).toBe(true); // newest on day −5
    expect(kept.has(older[3]!.id)).toBe(false);
  });

  it('a day already covered by the newest 10 gets no extra version', () => {
    const latest = Array.from({ length: 10 }, (_, i) => version(i * 60 * 1000));
    const sameDay = version(3 * HOUR); // today, but beyond the newest 10
    expect(versionsToKeep([...latest, sameDay], NOW, RULES).has(sameDay.id)).toBe(false);
  });

  it('beyond 30 days keeps one per week', () => {
    const latest = Array.from({ length: 10 }, (_, i) => version(i * 60 * 1000));
    // Wednesday 2026-11-25 minus 60 days = Saturday 2026-09-26; minus 61 = Friday (same week); minus 65 = Monday 09-21 (same week); minus 67 = previous week.
    const week = [version(60 * DAY), version(61 * DAY), version(65 * DAY), version(67 * DAY)];
    const kept = versionsToKeep([...latest, ...week], NOW, RULES);
    expect(week.map((v) => kept.has(v.id))).toEqual([true, false, false, true]);
  });

  it('follows changed rules', () => {
    const versions = Array.from({ length: 5 }, (_, i) => version(i * 60 * 1000));
    expect(versionsToKeep(versions, NOW, { keepLatest: 2, dailyForDays: 30 }).size).toBe(2);
  });
});
