import { describe, expect, it } from 'vitest';
import { GESTURES } from '../config';
import { TouchGestures } from './touchGestures';

const p = (x: number, y = 0) => ({ x, y });
const FINGER = 10; // contact size of a fingertip

describe('TouchGestures taps', () => {
  it('recognises a two-finger tap', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    g.down(2, p(100), FINGER, 20);
    expect(g.up(1, 120)).toBeNull();
    expect(g.up(2, 140)).toEqual({ fingers: 2 });
  });

  it('recognises a three-finger tap', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    g.down(2, p(50), FINGER, 10);
    g.down(3, p(100), FINGER, 20);
    g.up(1, 100);
    g.up(2, 110);
    expect(g.up(3, 120)).toEqual({ fingers: 3 });
  });

  it('ignores a single-finger tap', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    expect(g.up(1, 100)).toBeNull();
  });

  it('rejects taps that are too slow', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    g.down(2, p(100), FINGER, 0);
    g.up(1, GESTURES.tapMaxDurationMs + 1);
    expect(g.up(2, GESTURES.tapMaxDurationMs + 2)).toBeNull();
  });

  it('rejects taps where a finger moved (a pinch)', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    g.down(2, p(100), FINGER, 0);
    g.move(2, p(100 + GESTURES.tapMaxMovementPx + 1));
    g.up(2, 50);
    expect(g.up(1, 60)).toBeNull();
  });

  it('rejects palms and taps spoiled by the pen', () => {
    const palm = new TouchGestures();
    palm.down(1, p(0), GESTURES.palmContactPx + 1, 0);
    palm.down(2, p(100), FINGER, 0);
    palm.up(1, 50);
    expect(palm.up(2, 60)).toBeNull();

    const pen = new TouchGestures();
    pen.down(1, p(0), FINGER, 0);
    pen.down(2, p(100), FINGER, 0);
    pen.spoil();
    pen.up(1, 50);
    expect(pen.up(2, 60)).toBeNull();
  });

  it('starts a fresh session after all fingers lift', () => {
    const g = new TouchGestures();
    g.down(1, p(0), GESTURES.palmContactPx + 1, 0);
    g.up(1, 10);
    g.down(1, p(0), FINGER, 1000);
    g.down(2, p(100), FINGER, 1000);
    g.up(1, 1100);
    expect(g.up(2, 1100)).toEqual({ fingers: 2 });
  });
});

describe('TouchGestures hold', () => {
  it('a still single finger becomes a hold, and is not a tap', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    g.move(1, p(GESTURES.holdMaxMovementPx - 1));
    expect(g.checkHold(1)).toBe(true);
    expect(g.holdingTouch).toBe(1);
    expect(g.up(1, 900)).toBeNull();
    expect(g.holdingTouch).toBeNull();
  });

  it('a second finger after a hold can still make a two-finger tap', () => {
    const g = new TouchGestures();
    g.down(1, p(0), FINGER, 0);
    expect(g.checkHold(1)).toBe(true); // eyedropper tool: picks immediately
    g.down(2, p(100), FINGER, 30);
    g.releaseHold(); // the app cancels the pick
    g.up(1, 120);
    expect(g.up(2, 130)).toEqual({ fingers: 2 });
  });

  it('no hold if the finger moved, a second finger came, or it is a palm', () => {
    const moved = new TouchGestures();
    moved.down(1, p(0), FINGER, 0);
    moved.move(1, p(GESTURES.holdMaxMovementPx + 1));
    expect(moved.checkHold(1)).toBe(false);

    const two = new TouchGestures();
    two.down(1, p(0), FINGER, 0);
    two.down(2, p(100), FINGER, 0);
    two.up(2, 100);
    expect(two.checkHold(1)).toBe(false);

    const palm = new TouchGestures();
    palm.down(1, p(0), GESTURES.palmContactPx + 1, 0);
    expect(palm.checkHold(1)).toBe(false);
  });
});
