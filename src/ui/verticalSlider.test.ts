import { describe, expect, it } from 'vitest';
import { logScale } from './verticalSlider';

describe('logScale', () => {
  const size = logScale(1, 400);

  it('maps the ends of the bar to the smallest and largest value', () => {
    expect(size.toValue(0)).toBe(1);
    expect(size.toValue(1)).toBe(400);
    expect(size.toPosition(1)).toBe(0);
    expect(size.toPosition(400)).toBeCloseTo(1);
  });

  it('puts the geometric middle in the middle of the bar', () => {
    expect(size.toValue(0.5)).toBe(20); // √400
  });

  it('round-trips a value through a position', () => {
    expect(size.toValue(size.toPosition(37))).toBe(37);
  });
});
