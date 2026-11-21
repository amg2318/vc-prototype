import { describe, expect, it } from 'vitest';
import { createBlock } from '../document/inheritedBlock';
import { applyAffine, invertAffine, sourceToInheritor } from '../document/inheritedBlock';
import { blockBounds, blockLevel, blockSourceRect, packBlockLookup, packBlockUniforms } from './blockPacking';

const SOURCE = { width: 1024, height: 512 };
const INHERITOR = { width: 512, height: 512 };

describe('blockLevel', () => {
  it('matches the block scale on the inheritor', () => {
    expect(blockLevel(1)).toBe(0);
    expect(blockLevel(2)).toBe(0); // enlarged: full resolution
    expect(blockLevel(0.5)).toBe(1);
    expect(blockLevel(0.3)).toBe(1); // never coarser than the matching level
    expect(blockLevel(0.25)).toBe(2);
  });

  it('goes coarser when the inheritor is only needed at a coarser level, up to the last level', () => {
    expect(blockLevel(0.5, 2)).toBe(3);
    expect(blockLevel(0.01, 3)).toBe(4);
  });
});

describe('block geometry', () => {
  const block = createBlock('a', SOURCE, INHERITOR); // fit: scale 0.5, centred vertically

  it('bounds the block on the inheritor', () => {
    expect(blockBounds(block, SOURCE, INHERITOR)).toEqual({ x: 0, y: 128, width: 512, height: 256 });
  });

  it('maps an inheritor area back to the source part it shows', () => {
    expect(blockSourceRect(block, SOURCE, { x: 0, y: 128, width: 256, height: 256 })).toEqual({ x: 0, y: 0, width: 513, height: 512 });
    expect(blockSourceRect(block, SOURCE, { x: 0, y: 0, width: 512, height: 100 })).toBeNull(); // above the block
  });
});

describe('packBlockUniforms', () => {
  it('packs the inheritor → source matrix, cell size, crop, settings and effects', () => {
    const block = { ...createBlock('a', SOURCE, INHERITOR), opacity: 0.5, blendMode: 'overlay' as const };
    const u = packBlockUniforms({ ...block, effects: [{ kind: 'invert' }, { kind: 'posterize', levels: 4 }] }, SOURCE, 1);
    const toSource = invertAffine(sourceToInheritor(block, SOURCE));
    const p = applyAffine(toSource, 256, 256);
    expect(u[0]! * 256 + u[2]! * 256 + u[4]!).toBeCloseTo(p.x);
    expect(u[1]! * 256 + u[3]! * 256 + u[5]!).toBeCloseTo(p.y);
    expect([...u.slice(6, 8)]).toEqual([512, 1]); // level-1 cells cover 512 source px; block on
    expect([...u.slice(8, 12)]).toEqual([0, 0, 1024, 512]);
    expect([...u.slice(12, 16)]).toEqual([0.5, 3, 2, 0]);
    expect([...u.slice(16, 24)]).toEqual([2, 0, 0, 0, 3, 4, 0, 0]);
  });
});

describe('packBlockLookup', () => {
  it('stores each cell’s texture, texel origin and level, or plain paper', () => {
    const lookup = packBlockLookup(
      [
        { kind: 'tile', canvasRect: { x: 0, y: 0, width: 512, height: 512 }, pool: 'preview', page: 1, x: 256, y: 512, texels: { x: 0, y: 0, width: 256, height: 256 } },
        // Cell (1, 0) drawn from a coarser (level-2) tile: its right half.
        { kind: 'tile', canvasRect: { x: 512, y: 0, width: 512, height: 512 }, pool: 'preview', page: 0, x: 0, y: 0, texels: { x: 128, y: 0, width: 128, height: 128 } },
        { kind: 'paper', canvasRect: { x: 0, y: 512, width: 512, height: 512 }, color: [1, 0.5, 0] },
      ],
      1,
    );
    expect([...lookup.slice(0, 8)]).toEqual([3, 256, 512, 1, 256, 512, 0, 0]); // 1 level-0 page, so preview page 1 is texture 2 (+1)
    expect([...lookup.slice(8, 16)]).toEqual([2, 128, 0, 2, 0, 0, 0, 0]);
    expect([...lookup.slice(16 * 8, 16 * 8 + 8)]).toEqual([0, 0, 0, 0, 255, 128, 0, 0]); // row 1 starts at cell 16
  });
});
