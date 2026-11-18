import { describe, expect, it } from 'vitest';
import { hexToRgb, hsvToRgb, rgbFromPremultiplied8, rgbToHex, rgbToHsv } from './color';

describe('colour conversions', () => {
  it.each([
    [[1, 0, 0], { h: 0, s: 1, v: 1 }],
    [[0, 1, 0], { h: 120, s: 1, v: 1 }],
    [[0, 0, 1], { h: 240, s: 1, v: 1 }],
    [[0.5, 0.5, 0.5], { h: 0, s: 0, v: 0.5 }],
  ] as const)('rgb %j ↔ hsv %j', (rgb, hsv) => {
    const out = rgbToHsv([...rgb]);
    expect(out.h).toBeCloseTo(hsv.h);
    expect(out.s).toBeCloseTo(hsv.s);
    expect(out.v).toBeCloseTo(hsv.v);
    hsvToRgb(hsv).forEach((c, i) => expect(c).toBeCloseTo(rgb[i]!));
  });

  it('round-trips arbitrary colours', () => {
    for (const rgb of [[0.2, 0.7, 0.4], [0.9, 0.1, 0.6], [0.05, 0.05, 0.3]] as [number, number, number][]) {
      hsvToRgb(rgbToHsv(rgb)).forEach((c, i) => expect(c).toBeCloseTo(rgb[i]!));
    }
  });

  it('converts hex both ways', () => {
    expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
    hexToRgb('#ff8000').forEach((c, i) => expect(c).toBeCloseTo([1, 128 / 255, 0][i]!));
  });

  it('reads composite pixels', () => {
    expect(rgbFromPremultiplied8([255, 0, 51, 255])).toEqual([1, 0, 0.2]);
  });
});
