import { describe, expect, it } from 'vitest';
import { FingerDrawing, shouldCancelFingerStroke } from './fingerDrawing';

describe('FingerDrawing', () => {
  it('is on in auto mode until a pen is used', () => {
    const f = new FingerDrawing();
    let changes = 0;
    f.onChange(() => changes++);
    expect(f.enabled).toBe(true);
    f.notePen();
    expect(f.enabled).toBe(false);
    f.notePen();
    expect(changes).toBe(1);
  });

  it('follows on and off whatever the pen does', () => {
    const on = new FingerDrawing('on');
    on.notePen();
    expect(on.enabled).toBe(true);
    const off = new FingerDrawing('off');
    expect(off.enabled).toBe(false);
  });

  it('can be turned back on after the pen turned auto off', () => {
    const f = new FingerDrawing();
    f.notePen();
    f.setting = 'on';
    expect(f.enabled).toBe(true);
  });
});

describe('shouldCancelFingerStroke', () => {
  const t = { strokeCancelMs: 200, strokeCancelMovementPx: 30 };
  it('cancels a stroke that only just started', () => {
    expect(shouldCancelFingerStroke(80, 5, t)).toBe(true);
  });
  it('keeps a stroke that has been going a while or has moved', () => {
    expect(shouldCancelFingerStroke(300, 5, t)).toBe(false);
    expect(shouldCancelFingerStroke(80, 60, t)).toBe(false);
  });
});
