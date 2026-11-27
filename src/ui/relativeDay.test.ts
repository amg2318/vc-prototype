import { describe, expect, it } from 'vitest';
import { relativeDay } from './relativeDay';

describe('relativeDay', () => {
  // Friday 27 November 2026, mid-afternoon (local time).
  const now = new Date(2026, 10, 27, 15, 0).getTime();
  const at = (day: number, hour = 10): number => new Date(2026, 10, day, hour).getTime();

  it('says Today and Yesterday by calendar day, not by 24-hour periods', () => {
    expect(relativeDay(at(27, 0), now, 'en-US')).toBe('Today');
    expect(relativeDay(at(26, 23), now, 'en-US')).toBe('Yesterday');
    expect(relativeDay(at(26, 1), now, 'en-US')).toBe('Yesterday');
  });

  it('names the weekday within the last week', () => {
    expect(relativeDay(at(25), now, 'en-US')).toBe('Wednesday');
    expect(relativeDay(at(21), now, 'en-US')).toBe('Saturday');
  });

  it('gives the date for anything older', () => {
    expect(relativeDay(at(20), now, 'en-US')).toBe('Nov 20, 2026');
  });
});
