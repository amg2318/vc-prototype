import { describe, expect, it } from 'vitest';
import { createBlock, markSourceMissing } from '../document/inheritedBlock';
import { InheritanceGraph } from '../workspace/inheritanceGraph';
import { arrowEmphasis, arrowLines, arrowQuads, depthWarning, edgeToEdge, hitArrow, lineage, type ArrowCanvas } from './arrows';

const SIZE = { width: 100, height: 100 };

function canvas(id: string, x: number, y: number, source?: string): ArrowCanvas {
  return { id, placement: { x, y, ...SIZE }, inherited: source ? createBlock(source, SIZE, SIZE) : null };
}

describe('edgeToEdge', () => {
  it('runs between the facing edges, with a gap', () => {
    const line = edgeToEdge({ x: 0, y: 0, ...SIZE }, { x: 300, y: 0, ...SIZE }, 10);
    expect(line).toEqual({ from: { x: 110, y: 50 }, to: { x: 290, y: 50 } });
  });

  it('works diagonally', () => {
    const line = edgeToEdge({ x: 0, y: 0, ...SIZE }, { x: 300, y: 300, ...SIZE }, 0)!;
    expect(line.from.x).toBeCloseTo(100);
    expect(line.from.y).toBeCloseTo(100);
    expect(line.to.x).toBeCloseTo(300);
  });

  it('gives nothing for overlapping canvases', () => {
    expect(edgeToEdge({ x: 0, y: 0, ...SIZE }, { x: 50, y: 0, ...SIZE }, 0)).toBeNull();
  });
});

describe('arrowLines', () => {
  it('draws one arrow per linked block and a stub for a missing source', () => {
    const missing = { ...canvas('m', 0, 400), inherited: markSourceMissing(createBlock('gone', SIZE, SIZE)) };
    const lines = arrowLines([canvas('a', 0, 0), canvas('b', 300, 0, 'a'), canvas('e', 600, 0), missing], 1);
    expect(lines.map((l) => [l.inheritorId, l.kind])).toEqual([['b', 'linked'], ['m', 'missing']]);
    expect(lines[1]!.to.x).toBeLessThan(0); // just left of the inheritor
  });
});

describe('arrowEmphasis', () => {
  // a → b → c → d, plus x → y unrelated
  const canvases = [canvas('a', 0, 0), canvas('b', 200, 0, 'a'), canvas('c', 400, 0, 'b'), canvas('d', 600, 0, 'c'), canvas('x', 0, 300), canvas('y', 200, 300, 'x')];
  const lines = arrowLines(canvases, 1);
  const graph = new InheritanceGraph(canvases);

  it('is low with nothing selected', () => {
    expect([...arrowEmphasis(lines, graph, null, null).values()]).toEqual(['low', 'low', 'low', 'low']);
  });

  it('is full next to the selected canvas and medium along its lineage', () => {
    const e = arrowEmphasis(lines, graph, 'c', null);
    expect(Object.fromEntries(e)).toEqual({ b: 'medium', c: 'full', d: 'full', y: 'low' });
    const top = arrowEmphasis(lines, graph, 'a', null);
    expect(Object.fromEntries(top)).toEqual({ b: 'full', c: 'medium', d: 'medium', y: 'low' });
  });

  it('is full for the selected arrow', () => {
    expect(arrowEmphasis(lines, graph, null, 'y').get('y')).toBe('full');
  });
});

describe('arrowQuads', () => {
  it('draws a shaft and a two-stroke head, premultiplied at the emphasis opacity', () => {
    const lines = arrowLines([canvas('a', 0, 0), canvas('b', 300, 0, 'a')], 1);
    const quads = arrowQuads(lines, new Map([['b', 'low']]), 1);
    expect(quads).toHaveLength(3);
    const [r, , , a] = quads[0]!.color;
    expect(a).toBeLessThan(1);
    expect(r).toBeLessThanOrEqual(a);
  });

  it('keeps the same on-screen width at any zoom', () => {
    const lines = arrowLines([canvas('a', 0, 0), canvas('b', 300, 0, 'a')], 4);
    expect(Math.hypot(arrowQuads(lines, new Map(), 4)[0]!.yAxis.x, arrowQuads(lines, new Map(), 4)[0]!.yAxis.y)).toBeCloseTo(12);
  });
});

describe('hitArrow', () => {
  it('finds the arrow near a point', () => {
    const lines = arrowLines([canvas('a', 0, 0), canvas('b', 300, 0, 'a')], 1);
    expect(hitArrow(lines, { x: 200, y: 60 }, 15)?.inheritorId).toBe('b');
    expect(hitArrow(lines, { x: 200, y: 90 }, 15)).toBeNull();
  });
});

describe('lineage', () => {
  it('lists every canvas upstream and downstream of the selected one', () => {
    // a → b → c, b → d, plus x unrelated
    const canvases = [canvas('a', 0, 0), canvas('b', 200, 0, 'a'), canvas('c', 400, 0, 'b'), canvas('d', 400, 200, 'b'), canvas('x', 0, 400)];
    const graph = new InheritanceGraph(canvases);
    const { upstream, downstream } = lineage(graph, 'b');
    expect(upstream).toEqual(['a']);
    expect([...downstream].sort()).toEqual(['c', 'd']);
    expect(lineage(graph, 'a').downstream).toHaveLength(3); // the badge: 3 dependents
    expect(lineage(graph, null)).toEqual({ upstream: [], downstream: [] });
  });
});

describe('depthWarning', () => {
  it('warns once when the deepest chain grows past the limit, never otherwise', () => {
    expect(depthWarning(7, 8, 8)).toBeNull(); // at the limit
    expect(depthWarning(8, 9, 8)).toContain('9 levels deep');
    expect(depthWarning(9, 9, 8)).toBeNull(); // no growth: no repeat
    expect(depthWarning(10, 9, 8)).toBeNull(); // shrinking
  });

  it('measures the deepest chain in the graph', () => {
    const chain = [canvas('a', 0, 0), canvas('b', 200, 0, 'a'), canvas('c', 400, 0, 'b'), canvas('x', 0, 300)];
    expect(new InheritanceGraph(chain).maxDepth()).toBe(2);
    expect(new InheritanceGraph([canvas('x', 0, 0)]).maxDepth()).toBe(0);
  });
});
