import { describe, expect, it } from 'vitest';
import { SLOTS_PER_PAGE, TILE_COUNT, TILE_SIZE } from '../config';
import {
  EMPTY_CHECK_BLOCK,
  MERGE_INSTANCE_FLOATS,
  emptyTilesFromReadback,
  groupByDstPage,
  packCompositeUniforms,
  packLookup,
  packMergeInstance,
} from './compositePacking';
import type { CompositeInput } from './compositePacking';

const state: CompositeInput = {
  paper: [0.9, 0.9, 0.8],
  sources: [
    { kind: 'raster', opacity: 1, blendMode: 'normal', tiles: new Map([[0, 5]]) },
    { kind: 'raster', opacity: 0.5, blendMode: 'multiply', tiles: new Map([[3, 0], [0, 7]]) },
  ],
  liveStroke: { sourceIndex: 1, style: { color: [1, 0, 0], opacity: 0.8, mode: 'erase' } },
};

describe('packLookup', () => {
  it('stores slot + 1 per (source row, tile), 0 where there is no tile', () => {
    const t = packLookup(state);
    expect(t[0]).toBe(6);
    expect(t[1]).toBe(0);
    expect(t[TILE_COUNT + 3]).toBe(1); // slot 0 is stored as 1, distinct from "empty"
    expect(t[TILE_COUNT + 0]).toBe(8);
  });
});

describe('packCompositeUniforms', () => {
  it('packs paper, live stroke, counts and per-source opacity/blend mode', () => {
    const u = [...packCompositeUniforms(state)];
    expect(u.slice(0, 4).map((v) => +v.toFixed(3))).toEqual([0.9, 0.9, 0.8, 1]);
    expect(u.slice(4, 8).map((v) => +v.toFixed(3))).toEqual([1, 0, 0, 0.8]);
    expect(u.slice(8, 12)).toEqual([2, 1, 1, 4096]);
    expect(u.slice(12, 16)).toEqual([1, 0, 0, 0]);
    expect(u.slice(16, 20)).toEqual([0.5, 1, 0, 0]);
  });

  it('marks "no live stroke" with source index -1', () => {
    expect(packCompositeUniforms({ ...state, liveStroke: null })[9]).toBe(-1);
  });
});

describe('merge packing', () => {
  it('packs destination slot position, tile origin, colour, mode and canvas size', () => {
    const out = new Float32Array(MERGE_INSTANCE_FLOATS);
    const style = { color: [0.1, 0.2, 0.3] as [number, number, number], opacity: 0.5, mode: 'paint' as const };
    packMergeInstance({ key: 17, src: null, dst: 1 }, style, { width: 2480, height: 3508 }, out, 0);
    expect([...out.slice(0, 4)]).toEqual([TILE_SIZE, 0, TILE_SIZE, TILE_SIZE]);
    expect(out[7]).toBeCloseTo(0.5);
    expect([...out.slice(8, 11)]).toEqual([0, 2480, 3508]); // paint, clipped to the canvas size
  });

  it('groups jobs by destination page', () => {
    const jobs = [
      { key: 0, src: null, dst: 0 },
      { key: 1, src: null, dst: SLOTS_PER_PAGE + 2 },
      { key: 2, src: null, dst: 4 },
    ];
    const groups = groupByDstPage(jobs);
    expect(groups.get(0)!.map((j) => j.key)).toEqual([0, 2]);
    expect(groups.get(1)!.map((j) => j.key)).toEqual([1]);
  });
});

describe('emptyTilesFromReadback', () => {
  it('finds tiles whose block has no alpha anywhere', () => {
    const width = EMPTY_CHECK_BLOCK * 3;
    const pixels = new Uint8Array(width * EMPTY_CHECK_BLOCK * 4);
    // A single faint pixel in tile 1's block.
    pixels[(5 * width + EMPTY_CHECK_BLOCK + 9) * 4 + 3] = 1;
    expect(emptyTilesFromReadback(pixels, width, 3)).toEqual([true, false, true]);
  });
});
