import { describe, expect, it } from 'vitest';
import { blend, erase, paint, premultiply, type Premultiplied } from './blend';

function expectPixel(actual: Premultiplied, expected: Premultiplied): void {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6));
}

const opaqueWhite: Premultiplied = [1, 1, 1, 1];
const transparent: Premultiplied = [0, 0, 0, 0];

describe('paint', () => {
  it('full coverage replaces the pixel with the colour', () => {
    expectPixel(paint([0.2, 0.3, 0.4, 1], [1, 0, 0], 1), [1, 0, 0, 1]);
  });

  it('half coverage onto transparent gives a half-alpha premultiplied colour', () => {
    expectPixel(paint(transparent, [1, 0.5, 0], 0.5), [0.5, 0.25, 0, 0.5]);
  });

  it('zero coverage leaves the pixel unchanged', () => {
    expectPixel(paint([0.1, 0.2, 0.3, 0.4], [1, 1, 1], 0), [0.1, 0.2, 0.3, 0.4]);
  });
});

describe('erase', () => {
  it('full erase gives exactly transparent', () => {
    expectPixel(erase([0.3, 0.2, 0.1, 0.9], 1), transparent);
  });

  it('partial erase scales colour and alpha together, keeping the unpremultiplied colour', () => {
    const p = erase(premultiply([0.8, 0.4, 0.2], 1), 0.75);
    expect(p[3]).toBeCloseTo(0.25);
    expect(p[0] / p[3]).toBeCloseTo(0.8);
  });
});

describe('blend: normal', () => {
  it('opaque source covers the destination', () => {
    expectPixel(blend(opaqueWhite, [0, 0, 1, 1], 1, 'normal'), [0, 0, 1, 1]);
  });

  it('transparent source leaves the destination unchanged', () => {
    expectPixel(blend([0.2, 0.4, 0.6, 1], transparent, 1, 'normal'), [0.2, 0.4, 0.6, 1]);
  });

  it('layer opacity scales the source', () => {
    expectPixel(blend(opaqueWhite, [0, 0, 0, 1], 0.25, 'normal'), [0.75, 0.75, 0.75, 1]);
  });

  it('matches straight-alpha over for a semi-transparent source', () => {
    // Straight: red at alpha 0.5 over opaque blue → (0.5, 0, 0.5).
    expectPixel(blend([0, 0, 1, 1], premultiply([1, 0, 0], 0.5), 1, 'normal'), [0.5, 0, 0.5, 1]);
  });
});

describe('blend: multiply', () => {
  it('multiplies colours when both are opaque', () => {
    expectPixel(blend([0.5, 1, 0.2, 1], [0.5, 0.5, 1, 1], 1, 'multiply'), [0.25, 0.5, 0.2, 1]);
  });

  it('white is the identity', () => {
    const dst: Premultiplied = [0.3, 0.6, 0.9, 1];
    expectPixel(blend(dst, opaqueWhite, 1, 'multiply'), dst);
  });

  it('onto a transparent destination it behaves like normal', () => {
    const src = premultiply([0.4, 0.5, 0.6], 0.7);
    expectPixel(blend(transparent, src, 1, 'multiply'), blend(transparent, src, 1, 'normal'));
  });

  it('a half-opacity multiply is halfway between dst and the full multiply', () => {
    const dst: Premultiplied = [0.8, 0.8, 0.8, 1];
    const full = blend(dst, [0.5, 0.5, 0.5, 1], 1, 'multiply');
    const half = blend(dst, [0.5, 0.5, 0.5, 1], 0.5, 'multiply');
    expect(half[0]).toBeCloseTo((dst[0] + full[0]) / 2);
  });
});
