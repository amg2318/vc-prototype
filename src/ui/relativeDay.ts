const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A short, friendly day for a time: "today", "yesterday", a weekday within
 * the last week ("Thursday"), else the date ("12 Nov 2026" in the user's
 * locale). Days are calendar days in local time.
 */
export function relativeDay(time: number, now: number = Date.now(), locale?: string): string {
  const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const daysAgo = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (daysAgo <= 0) return 'today';
  if (daysAgo === 1) return 'yesterday';
  if (daysAgo < 7) return new Date(time).toLocaleDateString(locale, { weekday: 'long' });
  return new Date(time).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
