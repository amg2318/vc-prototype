import { describe, expect, it } from 'vitest';
import { IDENTITY_VIEW } from '../viewport/viewport';
import { TouchNavigator } from './gestures';

describe('TouchNavigator', () => {
  it('one finger does not navigate', () => {
    const nav = new TouchNavigator();
    nav.down(1, { x: 0, y: 0 }, IDENTITY_VIEW, 0);
    expect(nav.move(1, { x: 50, y: 50 })).toBeNull();
    expect(nav.isNavigating).toBe(false);
  });

  it('two fingers pan and pinch', () => {
    const nav = new TouchNavigator();
    nav.down(1, { x: 0, y: 0 }, IDENTITY_VIEW, 0);
    nav.down(2, { x: 100, y: 0 }, IDENTITY_VIEW, 0);
    expect(nav.isNavigating).toBe(true);
    const v = nav.move(2, { x: 200, y: 0 })!;
    expect(v.scale).toBeCloseTo(2);
  });

  it('pen down ignores current touches and restores the pre-gesture view', () => {
    const nav = new TouchNavigator();
    const start = { ...IDENTITY_VIEW, tx: 7 };
    nav.down(1, { x: 0, y: 0 }, start, 0);
    nav.down(2, { x: 100, y: 0 }, start, 0);
    nav.move(2, { x: 300, y: 0 });
    expect(nav.rejectAllForPen()).toEqual(start);
    expect(nav.isNavigating).toBe(false);
    // The palm touches stay ignored until they lift…
    nav.down(1, { x: 0, y: 0 }, start, 0);
    expect(nav.move(1, { x: 10, y: 0 })).toBeNull();
    // …and work again afterwards.
    nav.up(1);
    nav.up(2);
    nav.down(1, { x: 0, y: 0 }, start, 0);
    nav.down(2, { x: 100, y: 0 }, start, 0);
    expect(nav.isNavigating).toBe(true);
  });
});
