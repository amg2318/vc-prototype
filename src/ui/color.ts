import type { RGB } from '../document/blend';

/** Hue 0..360, saturation and value 0..1. */
export interface HSV {
  h: number;
  s: number;
  v: number;
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function rgbToHsv([r, g, b]: RGB): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

export function rgbToHex(rgb: RGB): string {
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}

/** Composite pixels are premultiplied but opaque (paper is opaque), so this just normalises. */
export function rgbFromPremultiplied8([r, g, b, a]: [number, number, number, number]): RGB {
  const alpha = a > 0 ? a : 255;
  return [r / alpha, g / alpha, b / alpha];
}
