import type { VersionEntry } from '../storage/format';

/**
 * Which versions to keep. Pure, so the rules are unit-tested.
 *
 *  - Manual and pinned versions are always kept.
 *  - Automatic versions: the newest `keepLatest`; of the rest, the newest of
 *    each calendar day for the last `dailyForDays` days; older than that,
 *    the newest of each week (weeks start on Monday). A day or week that
 *    already has a kept automatic version gets no second one.
 *
 * Days and weeks are local time (what the user sees in the list).
 */
export interface RetentionRules {
  keepLatest: number;
  dailyForDays: number;
}

/** What retention looks at. */
type Dated = Pick<VersionEntry, 'id' | 'kind' | 'pinned' | 'createdAt'>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function versionsToKeep(versions: readonly Dated[], now: number, rules: RetentionRules): Set<string> {
  const keep = new Set<string>();
  for (const v of versions) if (v.kind === 'manual' || v.pinned) keep.add(v.id);

  const autos = versions.filter((v) => v.kind === 'auto' && !v.pinned).sort((a, b) => b.createdAt - a.createdAt);
  const covered = new Set<string>(); // days and weeks that already have a kept automatic version
  const bucketsOf = (t: number): string[] => [dayKey(t), weekKey(t)];
  autos.slice(0, rules.keepLatest).forEach((v) => {
    keep.add(v.id);
    for (const b of bucketsOf(v.createdAt)) covered.add(b);
  });
  for (const v of autos.slice(rules.keepLatest)) {
    const recent = now - v.createdAt <= rules.dailyForDays * DAY_MS;
    const bucket = recent ? dayKey(v.createdAt) : weekKey(v.createdAt);
    if (covered.has(bucket)) continue;
    keep.add(v.id);
    for (const b of bucketsOf(v.createdAt)) covered.add(b);
  }
  return keep;
}

/** Apply the rules: the versions kept, in their original order. */
export function applyRetention<T extends Dated>(versions: readonly T[], now: number, rules: RetentionRules): T[] {
  const keep = versionsToKeep(versions, now, rules);
  return versions.filter((v) => keep.has(v.id));
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `day ${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The Monday starting the week of `t`, as a key. */
function weekKey(t: number): string {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `week ${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
