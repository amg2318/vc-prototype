import { describe, expect, it } from 'vitest';
import { CommandQueue, packDabs } from './commandQueue';

const style = { color: [0, 0, 0] as [number, number, number], opacity: 0.5 };
const dab = (x: number) => ({ x, y: 0, radius: 1, opacity: 1 });

describe('CommandQueue', () => {
  it('records a stroke as clear → dabs → merge, coalescing consecutive dab batches', () => {
    const q = new CommandQueue();
    q.beginStroke(style);
    q.addDabs([dab(1)]);
    q.addDabs([dab(2), dab(3)]);
    q.endStroke();
    const commands = q.drain();
    expect(commands.map((c) => c.kind)).toEqual(['clearStroke', 'dabs', 'mergeStroke']);
    expect(commands[1]!.kind === 'dabs' && commands[1]!.dabs).toHaveLength(3);
    expect(q.drain()).toEqual([]);
  });

  it('ignores dabs outside a stroke and clears the prediction on stroke end', () => {
    const q = new CommandQueue();
    q.addDabs([dab(1)]);
    expect(q.drain()).toEqual([]);
    q.beginStroke(style);
    q.setPrediction([dab(5)]);
    q.predictionChanged = false;
    q.endStroke();
    expect(q.predictedDabs).toEqual([]);
    expect(q.predictionChanged).toBe(true);
    expect(q.activeStyle).toBeNull();
  });

  it('does not flag an unchanged empty prediction', () => {
    const q = new CommandQueue();
    q.setPrediction([]);
    expect(q.predictionChanged).toBe(false);
  });
});

describe('packDabs', () => {
  it('writes x, y, radius, opacity at the given dab offset', () => {
    const out = new Float32Array(8);
    packDabs([{ x: 1, y: 2, radius: 3, opacity: 0.5 }], out, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 1, 2, 3, 0.5]);
  });
});
