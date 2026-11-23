import { VERSIONS } from '../config';
import type { RetentionRules } from './retention';

/**
 * Storage settings kept per device (localStorage): the retention rules for
 * automatic versions. Bad or missing values fall back to the defaults.
 */
const RETENTION_KEY = 'vc-retention';

export const DEFAULT_RETENTION: RetentionRules = { keepLatest: VERSIONS.keepLatest, dailyForDays: VERSIONS.dailyForDays };

export function parseRetention(text: string | null): RetentionRules {
  try {
    const value = JSON.parse(text ?? 'null') as Partial<RetentionRules> | null;
    const whole = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : fallback);
    return { keepLatest: whole(value?.keepLatest, DEFAULT_RETENTION.keepLatest), dailyForDays: whole(value?.dailyForDays, DEFAULT_RETENTION.dailyForDays) };
  } catch {
    return { ...DEFAULT_RETENTION };
  }
}

export function loadRetention(): RetentionRules {
  return parseRetention(localStorage.getItem(RETENTION_KEY));
}

export function saveRetention(rules: RetentionRules): void {
  localStorage.setItem(RETENTION_KEY, JSON.stringify(rules));
}

/**
 * True on iPad / iPhone in a Safari tab rather than the home-screen app.
 * Safari may clear a site's storage after some days without a visit; the
 * home-screen app's storage is not cleared that way, so the app suggests it.
 */
export function inIosBrowserTab(nav: Navigator & { standalone?: boolean } = navigator, standaloneQuery = () => matchMedia('(display-mode: standalone)').matches): boolean {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  return ios && nav.standalone !== true && !standaloneQuery();
}
