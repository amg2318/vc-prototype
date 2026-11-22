import { describe, expect, it } from 'vitest';
import { createBlock, type InheritedBlock } from '../document/inheritedBlock';
import { Propagation, type PropagationCanvas } from './propagation';

const SIZE = { width: 200, height: 200 };

/** A 200 × 200 canvas; `source` links an identity (fit, same size) block. */
function canvas(id: string, source?: string, changes: Partial<InheritedBlock['placement']> = {}): PropagationCanvas {
  if (!source) return { id, size: SIZE, inherited: null };
  const block = createBlock(source, SIZE, SIZE);
  return { id, size: SIZE, inherited: { ...block, placement: { ...block.placement, ...changes } } };
}

const stroke = { x: 50, y: 50, width: 10, height: 10 };

describe('Propagation', () => {
  it('passes a change down a 5-level chain, sources first', () => {
    const p = new Propagation([canvas('e', 'd'), canvas('d', 'c'), canvas('c', 'b'), canvas('b', 'a'), canvas('a')]);
    const out = p.propagate(new Map([['a', stroke]]));
    expect(out.map((c) => c.canvasId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.map((c) => c.inherited)).toEqual([false, true, true, true, true]);
    // Each identity step grows the area by one pixel each side (bilinear filtering).
    expect(out[4]!.rect).toEqual({ x: 46, y: 46, width: 18, height: 18 });
  });

  it('fans out to every inheritor', () => {
    const inheritors = Array.from({ length: 20 }, (_, i) => canvas(`f${i}`, 'a'));
    const out = new Propagation([canvas('a'), ...inheritors]).propagate(new Map([['a', stroke]]));
    expect(out).toHaveLength(21);
    expect(out[0]!.canvasId).toBe('a');
  });

  it('maps the change through each placement', () => {
    const p = new Propagation([canvas('a'), canvas('half', 'a', { mode: 'custom', scale: 0.5 }), canvas('moved', 'a', { mode: 'custom', x: 150 })]);
    const out = new Map(p.propagate(new Map([['a', stroke]])).map((c) => [c.canvasId, c.rect]));
    expect(out.get('half')).toEqual({ x: 74, y: 74, width: 7, height: 7 });
    expect(out.get('moved')).toEqual({ x: 99, y: 49, width: 12, height: 12 });
  });

  it('skips inheritors where the change is not shown, and their subtrees', () => {
    const p = new Propagation([canvas('a'), canvas('b', 'a', { mode: 'custom', x: 1000 }), canvas('c', 'b')]);
    expect(p.propagate(new Map([['a', stroke]])).map((c) => c.canvasId)).toEqual(['a']);
  });

  it('merges changes reaching a canvas from itself and from upstream', () => {
    const p = new Propagation([canvas('a'), canvas('b', 'a')]);
    const own = { x: 150, y: 150, width: 10, height: 10 };
    const out = p.propagate(new Map([['a', stroke], ['b', own]]));
    expect(out).toEqual([
      { canvasId: 'a', rect: stroke, inherited: false },
      { canvasId: 'b', rect: { x: 49, y: 49, width: 111, height: 111 }, inherited: false },
    ]);
  });

  it('leaves unrelated canvases out', () => {
    const p = new Propagation([canvas('a'), canvas('b', 'a'), canvas('x')]);
    expect(p.propagate(new Map([['a', stroke]])).map((c) => c.canvasId)).toEqual(['a', 'b']);
  });
});
