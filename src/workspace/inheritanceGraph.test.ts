import { describe, expect, it } from 'vitest';
import { createBlock, emptyBlock, markSourceMissing } from '../document/inheritedBlock';
import { InheritanceGraph, type GraphCanvas } from './inheritanceGraph';

const SIZE = { width: 100, height: 100 };

/** Canvases from "inheritor <- source" pairs; a bare id inherits nothing. */
function canvases(...links: string[]): GraphCanvas[] {
  return links.map((link) => {
    const [id, source] = link.split('<-');
    return { id: id!, inherited: source ? createBlock(source, SIZE, SIZE) : null };
  });
}

describe('InheritanceGraph', () => {
  it('reads arrows from linked blocks only', () => {
    const list = canvases('a', 'b<-a', 'c<-a', 'd<-a');
    list[2]!.inherited = emptyBlock(list[2]!.inherited!);
    list[3]!.inherited = markSourceMissing(list[3]!.inherited!);
    const g = new InheritanceGraph(list);
    expect(g.sourceOf('b')).toBe('a');
    expect(g.sourceOf('c')).toBeNull();
    expect(g.sourceOf('d')).toBeNull();
    expect(g.inheritorsOf('a')).toEqual(['b']);
  });

  it('ignores arrows from canvases that are not in the workspace', () => {
    const g = new InheritanceGraph(canvases('b<-gone'));
    expect(g.sourceOf('b')).toBeNull();
  });

  it('measures depth, upstream and downstream through a chain', () => {
    const g = new InheritanceGraph(canvases('a', 'b<-a', 'c<-b', 'd<-c', 'e<-b'));
    expect(g.depth('a')).toBe(0);
    expect(g.depth('d')).toBe(3);
    expect(g.upstream('d')).toEqual(['c', 'b', 'a']);
    expect(g.downstream('b').sort()).toEqual(['c', 'd', 'e']);
    expect(g.downstream('d')).toEqual([]);
  });

  describe('cycle detection', () => {
    const g = new InheritanceGraph(canvases('a', 'b<-a', 'c<-b', 'x'));

    it('refuses a canvas inheriting itself', () => {
      expect(g.wouldCycle('a', 'a')).toBe(true);
    });

    it('refuses closing a chain into a loop', () => {
      // a → b → c; making a inherit c would loop.
      expect(g.wouldCycle('a', 'c')).toBe(true);
      expect(g.wouldCycle('a', 'b')).toBe(true);
      expect(g.wouldCycle('b', 'c')).toBe(true);
    });

    it('allows chains, fan-outs and unrelated canvases', () => {
      expect(g.wouldCycle('x', 'c')).toBe(false); // extends the chain
      expect(g.wouldCycle('c', 'a')).toBe(false); // fan-out from a
      expect(g.wouldCycle('c', 'x')).toBe(false);
    });

    it('checks the new source when retargeting', () => {
      // Retarget c from b to x, then try to point x at c.
      const list = canvases('a', 'b<-a', 'c<-x', 'x');
      const after = new InheritanceGraph(list);
      expect(after.wouldCycle('x', 'c')).toBe(true);
      expect(after.wouldCycle('a', 'c')).toBe(false); // c no longer comes from a
    });
  });

  it('orders propagation sources-first through chains and fan-outs', () => {
    const g = new InheritanceGraph(canvases('d<-c', 'c<-b', 'b<-a', 'a', 'f1<-a', 'f2<-a', 'u'));
    const order = g.propagationOrder(['a']);
    expect(order.sort()).toEqual(['a', 'b', 'c', 'd', 'f1', 'f2'].sort());
    const ordered = g.propagationOrder(['a']);
    const before = (x: string, y: string): boolean => ordered.indexOf(x) < ordered.indexOf(y);
    expect(before('a', 'b') && before('b', 'c') && before('c', 'd')).toBe(true);
    expect(before('a', 'f1') && before('a', 'f2')).toBe(true);
  });

  it('lists each canvas once when several changed canvases share a chain', () => {
    const g = new InheritanceGraph(canvases('a', 'b<-a', 'c<-b'));
    expect(g.propagationOrder(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });
});
