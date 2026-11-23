import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, inIosBrowserTab, parseRetention } from './storageSettings';

describe('storage settings', () => {
  it('reads retention rules, falling back to the defaults for bad values', () => {
    expect(parseRetention('{"keepLatest":3,"dailyForDays":7}')).toEqual({ keepLatest: 3, dailyForDays: 7 });
    expect(parseRetention('{"keepLatest":-1,"dailyForDays":"x"}')).toEqual(DEFAULT_RETENTION);
    expect(parseRetention('not json')).toEqual(DEFAULT_RETENTION);
    expect(parseRetention(null)).toEqual(DEFAULT_RETENTION);
  });

  it('recognises an iPad Safari tab (iPadOS reports itself as a Mac with touch)', () => {
    const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5 } as Navigator;
    const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 0 } as Navigator;
    expect(inIosBrowserTab(ipad, () => false)).toBe(true);
    expect(inIosBrowserTab(ipad, () => true)).toBe(false); // home-screen app
    expect(inIosBrowserTab({ ...ipad, standalone: true } as Navigator, () => false)).toBe(false);
    expect(inIosBrowserTab(mac, () => false)).toBe(false);
  });
});
