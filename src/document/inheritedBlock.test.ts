import { describe, expect, it } from 'vitest';
import {
  applyAffine,
  createBlock,
  emptyBlock,
  fitPlacement,
  inheritorDirtyRect,
  invertAffine,
  linkBlock,
  markSourceMissing,
  refitBlock,
  sourceToInheritor,
  type InheritedBlock,
} from './inheritedBlock';

const SOURCE = { width: 400, height: 200 };
const INHERITOR = { width: 200, height: 200 };

function custom(block: InheritedBlock, changes: Partial<InheritedBlock['placement']>): InheritedBlock {
  return { ...block, placement: { ...block.placement, ...changes, mode: 'custom' } };
}

describe('block states', () => {
  it('goes linked → empty → linked, keeping its settings', () => {
    const linked = { ...createBlock('a', SOURCE, INHERITOR), opacity: 0.5, blendMode: 'multiply' as const, effects: [{ kind: 'invert' as const }] };
    const empty = emptyBlock(linked);
    expect(empty.source).toEqual({ kind: 'empty' });
    const relinked = linkBlock(empty, 'b', SOURCE, INHERITOR);
    expect(relinked.source).toEqual({ kind: 'linked', canvasId: 'b' });
    expect([relinked.opacity, relinked.blendMode, relinked.effects]).toEqual([0.5, 'multiply', [{ kind: 'invert' }]]);
  });

  it('goes linked → missing → relinked, remembering the lost source', () => {
    const missing = markSourceMissing(createBlock('a', SOURCE, INHERITOR));
    expect(missing.source).toEqual({ kind: 'missing', lastCanvasId: 'a' });
    expect(markSourceMissing(emptyBlock(missing)).source).toEqual({ kind: 'empty' }); // only linked blocks go missing
    expect(linkBlock(missing, 'a', SOURCE, INHERITOR).source).toEqual({ kind: 'linked', canvasId: 'a' });
  });
});

describe('placement', () => {
  it('fits inside the inheritor, centred, keeping the aspect ratio', () => {
    expect(fitPlacement(undefined, SOURCE, INHERITOR)).toMatchObject({ mode: 'fit', x: 100, y: 100, scale: 0.5 });
    expect(fitPlacement(undefined, { width: 100, height: 400 }, INHERITOR).scale).toBe(0.5);
  });

  it('refits a fitted block to a new source', () => {
    const block = linkBlock(createBlock('a', SOURCE, INHERITOR), 'b', { width: 100, height: 100 }, INHERITOR);
    expect(block.placement).toMatchObject({ mode: 'fit', scale: 2 });
  });

  it('keeps a custom placement on retarget, and its displayed width', () => {
    const block = custom(createBlock('a', SOURCE, INHERITOR), { x: 30, y: 40, scale: 0.25, rotation: 1, flipX: true });
    // 400 px wide at 0.25 = 100 px on the inheritor; the new source is 200 px wide.
    const after = linkBlock(block, 'b', { width: 200, height: 300 }, INHERITOR);
    expect(after.placement).toEqual({ mode: 'custom', x: 30, y: 40, scale: 0.5, rotation: 1, flipX: true, flipY: false });
  });

  it('keeps the displayed width after a detour through empty', () => {
    const block = emptyBlock(custom(createBlock('a', SOURCE, INHERITOR), { scale: 0.25 }));
    expect(linkBlock(block, 'b', { width: 100, height: 100 }, INHERITOR).placement.scale).toBe(1);
  });

  it('refit returns to a centred fit', () => {
    const block = custom(createBlock('a', SOURCE, INHERITOR), { x: 3, rotation: 2, flipY: true });
    expect(refitBlock(block, SOURCE, INHERITOR).placement).toEqual(fitPlacement(undefined, SOURCE, INHERITOR));
  });
});

describe('normalized crop', () => {
  it('shows the same part of sources of different sizes', () => {
    const crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const small = { ...createBlock('a', { width: 100, height: 100 }, INHERITOR), crop };
    const big = { ...createBlock('a', { width: 1000, height: 1000 }, INHERITOR), crop };
    const fitSmall = refitBlock(small, { width: 100, height: 100 }, INHERITOR);
    const fitBig = refitBlock(big, { width: 1000, height: 1000 }, INHERITOR);
    // The crop's top-left corner lands at the same inheritor point for both.
    const a = applyAffine(sourceToInheritor(fitSmall, { width: 100, height: 100 }), 50, 0);
    const b = applyAffine(sourceToInheritor(fitBig, { width: 1000, height: 1000 }), 500, 0);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });

  it('fits the cropped part, not the whole source', () => {
    const p = fitPlacement({ x: 0, y: 0, width: 0.25, height: 0.5 }, SOURCE, INHERITOR); // 100 × 100 px
    expect(p.scale).toBe(2);
  });
});

describe('dirty rectangle transform', () => {
  const block = createBlock('a', { width: 200, height: 200 }, INHERITOR); // scale 1, centred: identity
  const dirty = { x: 10, y: 20, width: 30, height: 40 };

  it('maps an identity placement to the same region (grown by a pixel for filtering)', () => {
    expect(inheritorDirtyRect(block, { width: 200, height: 200 }, INHERITOR, dirty)).toEqual({ x: 9, y: 19, width: 32, height: 42 });
  });

  it.each([
    ['moved', { x: 150 }, { x: 59, y: 19, width: 32, height: 42 }],
    ['scaled', { scale: 0.5 }, { x: 54, y: 59, width: 17, height: 22 }],
    ['flipped horizontally', { flipX: true }, { x: 159, y: 19, width: 32, height: 42 }],
    ['flipped vertically', { flipY: true }, { x: 9, y: 139, width: 32, height: 42 }],
    ['rotated a quarter turn', { rotation: Math.PI / 2 }, { x: 139, y: 9, width: 42, height: 32 }],
  ])('maps a %s placement', (_name, changes, expected) => {
    const r = inheritorDirtyRect(custom(block, changes), { width: 200, height: 200 }, INHERITOR, dirty);
    expect(r).toEqual(expected);
  });

  it('covers the whole rotated area for odd angles', () => {
    const rotated = custom(block, { rotation: Math.PI / 4 });
    // Near the centre, so the rotated corners stay on the canvas (off-canvas parts are clipped).
    const r = inheritorDirtyRect(rotated, { width: 200, height: 200 }, INHERITOR, { x: 80, y: 90, width: 30, height: 20 })!;
    const m = sourceToInheritor(rotated, { width: 200, height: 200 });
    for (const [x, y] of [[80, 90], [110, 90], [80, 110], [110, 110]] as const) {
      const p = applyAffine(m, x, y);
      expect(p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height).toBe(true);
    }
  });

  it('is null when the change is outside the crop or lands off the canvas', () => {
    const cropped = { ...block, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
    expect(inheritorDirtyRect(cropped, { width: 200, height: 200 }, INHERITOR, dirty)).toBeNull();
    expect(inheritorDirtyRect(custom(block, { x: 1000 }), { width: 200, height: 200 }, INHERITOR, dirty)).toBeNull();
  });

  it('round-trips through the inverse transform', () => {
    const m = sourceToInheritor(custom(block, { scale: 1.7, rotation: 0.6, flipX: true, x: 12 }), { width: 200, height: 200 });
    const back = applyAffine(invertAffine(m), ...(Object.values(applyAffine(m, 33, 44)) as [number, number]));
    expect(back.x).toBeCloseTo(33);
    expect(back.y).toBeCloseTo(44);
  });
});
