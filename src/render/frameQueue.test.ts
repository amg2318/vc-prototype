import { describe, expect, it } from 'vitest';
import { FrameQueue, packDabs } from './frameQueue';

const dab = (x: number, y = 10) => ({ x, y, radius: 2, opacity: 1 });

describe('FrameQueue', () => {
  it('records ops in order, coalescing consecutive dab batches', () => {
    const q = new FrameQueue();
    q.clearMask();
    q.addDabs([dab(10)]);
    q.addDabs([dab(20)]);
    q.push({ kind: 'copies', zero: [1], copies: [] });
    const frame = q.drain();
    expect(frame.ops.map((o) => o.kind)).toEqual(['clearMask', 'dabs', 'copies']);
    expect(frame.ops[1]!.kind === 'dabs' && frame.ops[1]!.dabs).toHaveLength(2);
    expect(q.drain().ops).toEqual([]);
  });

  it('reports the prediction only when it changed', () => {
    const q = new FrameQueue();
    q.setPrediction([dab(10)]);
    expect(q.drain().prediction).toHaveLength(1);
    expect(q.drain().prediction).toBeNull();
    q.setPrediction([]);
    expect(q.drain().prediction).toEqual([]);
    q.setPrediction([]);
    expect(q.drain().prediction).toBeNull();
  });
});

describe('packDabs', () => {
  it('writes x, y, radius, opacity at the given dab offset', () => {
    const out = new Float32Array(8);
    packDabs([{ x: 1, y: 2, radius: 3, opacity: 0.5 }], out, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 1, 2, 3, 0.5]);
  });
});
