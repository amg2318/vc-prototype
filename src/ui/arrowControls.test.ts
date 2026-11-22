import { describe, expect, it } from 'vitest';
import { TileStore } from '../document/tileStore';
import { Workspace } from '../workspace/workspace';
import { completeConnection, isValidTarget } from './arrowControls';

/** a → b → c, and a separate d. */
function setup() {
  const ws = new Workspace(new TileStore(16));
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name, i) => ws.createCanvas({ width: 200, height: 200 }, { x: i * 300, y: 0 }, name));
  ws.connect(b!.id, a!.id);
  ws.connect(c!.id, b!.id);
  ws.history.clear();
  return { ws, a: a!.id, b: b!.id, c: c!.id, d: d!.id };
}

describe('choosing a canvas for an arrow', () => {
  it('creating: any canvas except the source and its ancestors', () => {
    const { ws, a, b, c, d } = setup();
    const create = { kind: 'create' as const, sourceId: c };
    expect([a, b, c, d].map((id) => isValidTarget(ws, create, id))).toEqual([false, false, false, true]);
  });

  it('changing the source: nothing downstream of the inheritor', () => {
    const { ws, a, b, c, d } = setup();
    const source = { kind: 'source' as const, inheritorId: b };
    expect([a, b, c, d].map((id) => isValidTarget(ws, source, id))).toEqual([true, false, false, true]);
  });

  it('moving the head: not the source, its ancestors, or the current inheritor', () => {
    const { ws, a, b, c, d } = setup();
    const head = { kind: 'head' as const, inheritorId: c }; // the arrow b → c
    expect([a, b, c, d].map((id) => isValidTarget(ws, head, id))).toEqual([false, false, false, true]);
  });

  it('completes each kind as one undo step, and refuses invalid targets', () => {
    const { ws, a, b, c, d } = setup();
    expect(completeConnection(ws, { kind: 'create', sourceId: c }, a)).toBeNull(); // would cycle
    expect(ws.history.canUndo).toBe(false);
    expect(completeConnection(ws, { kind: 'source', inheritorId: c }, d)).toBe(c);
    expect(ws.graph().sourceOf(c)).toBe(d);
    expect(completeConnection(ws, { kind: 'head', inheritorId: b }, d)).toBe(d);
    expect(ws.graph().sourceOf(d)).toBe(a);
    expect(ws.history.undoCount).toBe(2);
  });
});
