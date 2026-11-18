import { describe, expect, it } from 'vitest';
import {
  docToClipMatrix,
  docToScreen,
  fitToView,
  panBy,
  screenToDoc,
  twoFingerTransform,
  zoomAt,
  type Vec2,
  type ViewTransform,
} from './viewport';

function expectClose(actual: Vec2, expected: Vec2, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

const rotated: ViewTransform = { scale: 2.5, rotation: 0.7, tx: 120, ty: -40 };

describe('docToScreen / screenToDoc', () => {
  it('are inverses, including with rotation', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 2048, y: 0 },
      { x: 333.3, y: 1777.7 },
    ]) {
      expectClose(screenToDoc(rotated, docToScreen(rotated, p)), p);
      expectClose(docToScreen(rotated, screenToDoc(rotated, p)), p);
    }
  });

  it('applies scale then translation without rotation', () => {
    const v = { scale: 2, rotation: 0, tx: 10, ty: 20 };
    expectClose(docToScreen(v, { x: 5, y: 7 }), { x: 20, y: 34 });
  });

  it('rotates clockwise on screen for positive rotation', () => {
    const v = { scale: 1, rotation: Math.PI / 2, tx: 0, ty: 0 };
    // Doc +x axis should point down the screen (+y).
    expectClose(docToScreen(v, { x: 1, y: 0 }), { x: 0, y: 1 });
  });
});

describe('panBy', () => {
  it('moves the document by the screen delta', () => {
    const v = panBy(rotated, 15, -5);
    const p = { x: 100, y: 200 };
    const before = docToScreen(rotated, p);
    expectClose(docToScreen(v, p), { x: before.x + 15, y: before.y - 5 });
  });
});

describe('zoomAt', () => {
  it('keeps the document point under the cursor fixed', () => {
    const cursor = { x: 400, y: 300 };
    const docUnderCursor = screenToDoc(rotated, cursor);
    const v = zoomAt(rotated, cursor, 1.8);
    expect(v.scale).toBeCloseTo(rotated.scale * 1.8);
    expectClose(docToScreen(v, docUnderCursor), cursor);
  });

  it('clamps to the zoom limits', () => {
    const v = zoomAt(rotated, { x: 0, y: 0 }, 1000, { min: 0.1, max: 8 });
    expect(v.scale).toBe(8);
  });
});

describe('twoFingerTransform', () => {
  const start: ViewTransform = { scale: 1, rotation: 0, tx: 0, ty: 0 };

  it('pans when both fingers move by the same amount', () => {
    const v = twoFingerTransform(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 40 }, { x: 130, y: 40 }, true);
    expect(v.scale).toBeCloseTo(1);
    expect(v.rotation).toBeCloseTo(0);
    expect(v.tx).toBeCloseTo(30);
    expect(v.ty).toBeCloseTo(40);
  });

  it('zooms by the ratio of finger distances, keeping fingers on the same doc points', () => {
    const a0 = { x: 100, y: 100 };
    const b0 = { x: 200, y: 100 };
    const a1 = { x: 50, y: 100 };
    const b1 = { x: 250, y: 100 };
    const v = twoFingerTransform(start, a0, b0, a1, b1, false);
    expect(v.scale).toBeCloseTo(2);
    expectClose(docToScreen(v, screenToDoc(start, a0)), a1);
    expectClose(docToScreen(v, screenToDoc(start, b0)), b1);
  });

  it('rotates only when allowed', () => {
    const a0 = { x: 0, y: 0 };
    const b0 = { x: 100, y: 0 };
    const a1 = { x: 0, y: 0 };
    const b1 = { x: 0, y: 100 };
    expect(twoFingerTransform(start, a0, b0, a1, b1, true).rotation).toBeCloseTo(Math.PI / 2);
    expect(twoFingerTransform(start, a0, b0, a1, b1, false).rotation).toBe(0);
  });

  it('does not produce NaN when fingers coincide', () => {
    const p = { x: 10, y: 10 };
    const v = twoFingerTransform(start, p, p, p, p, true);
    expect(Number.isFinite(v.scale) && Number.isFinite(v.tx) && Number.isFinite(v.rotation)).toBe(true);
  });
});

describe('fitToView', () => {
  it('centres the document and fits the smaller dimension', () => {
    const v = fitToView(2048, 2048, 1024, 768, 0);
    expect(v.scale).toBeCloseTo(768 / 2048);
    expectClose(docToScreen(v, { x: 1024, y: 1024 }), { x: 512, y: 384 });
  });
});

describe('docToClipMatrix', () => {
  function apply(m: Float64Array, p: Vec2): Vec2 {
    return {
      x: m[0]! * p.x + m[3]! * p.y + m[6]!,
      y: m[1]! * p.x + m[4]! * p.y + m[7]!,
    };
  }

  it('maps screen corners to clip corners (y up)', () => {
    const view = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    const m = docToClipMatrix(view, 800, 600);
    expectClose(apply(m, { x: 0, y: 0 }), { x: -1, y: 1 }, 5);
    expectClose(apply(m, { x: 800, y: 600 }), { x: 1, y: -1 }, 5);
  });

  it('agrees with docToScreen for a rotated view', () => {
    const w = 1180;
    const h = 820;
    const m = docToClipMatrix(rotated, w, h);
    const p = { x: 512, y: 77 };
    const s = docToScreen(rotated, p);
    expectClose(apply(m, p), { x: (s.x / w) * 2 - 1, y: 1 - (s.y / h) * 2 }, 4);
  });
});
