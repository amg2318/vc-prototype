import { describe, expect, it } from 'vitest';
import { blockFrame, dragPlacement, frameCorners, MIN_SCALE, normalizeAngle, rotateHandle, snapAngle } from './blockTransform';
import { createBlock, type BlockPlacement } from './inheritedBlock';

const placement: BlockPlacement = { mode: 'custom', x: 100, y: 100, scale: 1, rotation: 0, flipX: false, flipY: false };

describe('block frame', () => {
  it('is the cropped source at its scale, around the placement centre', () => {
    const block = { ...createBlock('a', { width: 200, height: 100 }, { width: 400, height: 400 }), crop: { x: 0, y: 0, width: 0.5, height: 1 } };
    const frame = blockFrame({ ...block, placement: { ...placement, scale: 2 } }, { width: 200, height: 100 });
    expect(frame).toEqual({ centre: { x: 100, y: 100 }, halfWidth: 100, halfHeight: 100, rotation: 0 });
  });

  it('rotates its corners and rotate handle with the block', () => {
    const frame = { centre: { x: 0, y: 0 }, halfWidth: 20, halfHeight: 10, rotation: Math.PI / 2 };
    const [topLeft] = frameCorners(frame);
    expect(topLeft!.x).toBeCloseTo(10);
    expect(topLeft!.y).toBeCloseTo(-20);
    const handle = rotateHandle(frame, 5); // "up" is now +x
    expect(handle.x).toBeCloseTo(15);
    expect(handle.y).toBeCloseTo(0);
  });
});

describe('dragPlacement', () => {
  it('moves the centre with the pointer', () => {
    expect(dragPlacement({ kind: 'move', start: { x: 110, y: 90 }, placement }, { x: 140, y: 80 })).toEqual({ x: 130, y: 90 });
  });

  it('scales about the centre by the change in distance, never below the minimum', () => {
    const drag = { kind: 'scale' as const, start: { x: 150, y: 100 }, placement };
    expect(dragPlacement(drag, { x: 200, y: 100 })).toEqual({ scale: 2 });
    expect(dragPlacement(drag, { x: 100, y: 125 })).toEqual({ scale: 0.5 }); // direction doesn't matter
    expect(dragPlacement(drag, { x: 100, y: 100 })).toEqual({ scale: MIN_SCALE });
  });

  it('rotates by the change in angle around the centre, snapping near 15° steps', () => {
    const drag = { kind: 'rotate' as const, start: { x: 100, y: 50 }, placement }; // straight above
    expect(dragPlacement(drag, { x: 150, y: 100 }).rotation).toBeCloseTo(Math.PI / 2);
    const unsnapped = dragPlacement(drag, { x: 100 + 50 * Math.sin(0.3), y: 100 - 50 * Math.cos(0.3) }).rotation!;
    expect(unsnapped).toBeCloseTo(0.3);
    const nearly45 = (44 * Math.PI) / 180;
    expect(dragPlacement(drag, { x: 100 + 50 * Math.sin(nearly45), y: 100 - 50 * Math.cos(nearly45) }).rotation).toBeCloseTo(Math.PI / 4);
  });
});

describe('angles', () => {
  it('normalizes to (-π, π] and snaps only when close', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
    expect(snapAngle(0.01)).toBe(0);
    expect(snapAngle(0.1)).toBe(0.1);
  });
});
