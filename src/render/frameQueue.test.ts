import { describe, expect, it } from 'vitest';
import { TILE_COUNT, TILE_SIZE } from '../config';
import { tileKey } from '../document/tiles';
import { FrameQueue, packDabs } from './frameQueue';

const dab = (x: number, y = 10) => ({ x, y, radius: 2, opacity: 1 });
const paintStyle = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };

describe('FrameQueue', () => {
  it('composites everything on the first frame, then only dirty tiles', () => {
    const q = new FrameQueue();
    expect(q.drain().dirty).toHaveLength(TILE_COUNT);
    expect(q.drain().dirty).toEqual([]);
    expect(q.hasWork).toBe(false);
  });

  it('records ops in order, coalescing consecutive dab batches, and marks dab tiles dirty', () => {
    const q = new FrameQueue();
    q.drain();
    q.clearMask();
    q.addDabs([dab(10)]);
    q.addDabs([dab(TILE_SIZE + 10)]);
    q.merge([{ key: 0, src: null, dst: 3 }], paintStyle);
    const frame = q.drain();
    expect(frame.ops.map((o) => o.kind)).toEqual(['clearMask', 'dabs', 'merge']);
    expect(frame.dirty.sort()).toEqual([tileKey(0, 0), tileKey(1, 0)]);
  });

  it('dirties both the old and the new prediction', () => {
    const q = new FrameQueue();
    q.drain();
    q.setPrediction([dab(10)]);
    q.drain();
    q.setPrediction([dab(TILE_SIZE * 2 + 10)]);
    const frame = q.drain();
    expect(frame.prediction).toHaveLength(1);
    expect(frame.dirty.sort()).toEqual([tileKey(0, 0), tileKey(2, 0)]);
  });

  it('reports composite state only when it changed', () => {
    const q = new FrameQueue();
    expect(q.drain().state).not.toBeNull();
    expect(q.drain().state).toBeNull();
    q.setState({ paper: [1, 1, 1], sources: [], liveStroke: null });
    expect(q.drain().state).not.toBeNull();
  });
});

describe('packDabs', () => {
  it('writes x, y, radius, opacity at the given dab offset', () => {
    const out = new Float32Array(8);
    packDabs([{ x: 1, y: 2, radius: 3, opacity: 0.5 }], out, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 1, 2, 3, 0.5]);
  });
});
