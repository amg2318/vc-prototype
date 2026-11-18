/**
 * Reference implementation of the pixel math, in premultiplied alpha.
 *
 * The GPU shaders (render/webgpu/shaders.ts, render/webgl2/shaders.ts) do the
 * same arithmetic; this file exists so the formulas can be unit-tested and
 * read in one place. All values are 0..1.
 *
 * Premultiplied means a pixel stores (r·a, g·a, b·a, a). It makes "over"
 * compositing a single multiply-add and makes erasing exact: scaling all four
 * channels by (1 − amount) removes colour and coverage together.
 */

export type Premultiplied = [r: number, g: number, b: number, a: number];
export type RGB = [number, number, number];

export type BlendMode = 'normal' | 'multiply';
/** Shader-side numeric ids. Screen and overlay will be added here. */
export const BLEND_MODE_IDS: Record<BlendMode, number> = { normal: 0, multiply: 1 };

export function premultiply(rgb: RGB, alpha: number): Premultiplied {
  return [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, alpha];
}

/** Brush paint: source-over of a solid colour with coverage `amount` (mask × stroke opacity). */
export function paint(dst: Premultiplied, color: RGB, amount: number): Premultiplied {
  const k = 1 - amount;
  return [
    color[0] * amount + dst[0] * k,
    color[1] * amount + dst[1] * k,
    color[2] * amount + dst[2] * k,
    amount + dst[3] * k,
  ];
}

/** Eraser: remove `amount` of the existing pixel (to transparent). */
export function erase(dst: Premultiplied, amount: number): Premultiplied {
  const k = 1 - amount;
  return [dst[0] * k, dst[1] * k, dst[2] * k, dst[3] * k];
}

/** Composite a layer pixel (`src`, at layer `opacity`) onto `dst` with a blend mode. */
export function blend(dst: Premultiplied, src: Premultiplied, opacity: number, mode: BlendMode): Premultiplied {
  const s: Premultiplied = [src[0] * opacity, src[1] * opacity, src[2] * opacity, src[3] * opacity];
  const sa = s[3];
  const da = dst[3];
  const outA = sa + da * (1 - sa);
  switch (mode) {
    case 'normal':
      return [s[0] + dst[0] * (1 - sa), s[1] + dst[1] * (1 - sa), s[2] + dst[2] * (1 - sa), outA];
    case 'multiply': {
      // Premultiplied form of the W3C compositing formula with B(cs, cb) = cs·cb:
      //   co = cs·cb + cs·(1 − ab) + cb·(1 − as)
      const ch = (i: number): number => s[i]! * dst[i]! + s[i]! * (1 - da) + dst[i]! * (1 - sa);
      return [ch(0), ch(1), ch(2), outA];
    }
  }
}
