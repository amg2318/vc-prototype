import { describe, expect, it } from 'vitest';
import { wheelAction, type WheelInput } from './wheel';

const wheel = (over: Partial<WheelInput>): WheelInput => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...over,
});

describe('wheelAction', () => {
  it('pans with a two-finger scroll, moving the content against the scroll', () => {
    expect(wheelAction(wheel({ deltaX: 10, deltaY: -4 }))).toEqual({ kind: 'pan', dx: -10, dy: 4 });
  });

  it('pans sideways with Shift + a vertical mouse wheel', () => {
    expect(wheelAction(wheel({ deltaY: 100, shiftKey: true }))).toEqual({ kind: 'pan', dx: -100, dy: -0 });
  });

  it('converts line-based deltas to pixels', () => {
    expect(wheelAction(wheel({ deltaY: 3, deltaMode: 1 }))).toEqual({ kind: 'pan', dx: -0, dy: -48 });
  });

  it('zooms with a pinch (Ctrl + wheel) and with ⌘ + wheel, in at negative delta', () => {
    const pinch = wheelAction(wheel({ deltaY: -5, ctrlKey: true }));
    expect(pinch.kind === 'zoom' && pinch.factor).toBeCloseTo(Math.exp(0.05));
    const out = wheelAction(wheel({ deltaY: 5, metaKey: true }));
    expect(out.kind === 'zoom' && out.factor).toBeLessThan(1);
  });

  it('limits how far one mouse-wheel notch zooms', () => {
    const notch = wheelAction(wheel({ deltaY: -400, metaKey: true }));
    expect(notch.kind === 'zoom' && notch.factor).toBeCloseTo(Math.exp(0.5));
  });
});
