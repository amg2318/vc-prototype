import { describe, expect, it } from 'vitest';
import { blockFrame, dragCrop, dragPlacement, frameCorners, MIN_CROP_PX, MIN_SCALE, normalizeAngle, rotateHandle, snapAngle } from './blockTransform';
import { applyAffine, createBlock, sourceToInheritor, type BlockPlacement, type InheritedBlock } from './inheritedBlock';

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

describe('dragCrop', () => {
  const sourceSize = { width: 200, height: 100 };
  const blockWith = (p: Partial<BlockPlacement>): InheritedBlock => ({
    ...createBlock('a', sourceSize, { width: 400, height: 400 }),
    placement: { ...placement, ...p },
  });
  /** Where a source pixel lands on the inheritor. */
  const at = (block: InheritedBlock, x: number, y: number) => applyAffine(sourceToInheritor(block, sourceSize), x, y);

  it('moves the dragged edge with the pointer and keeps the content where it was', () => {
    const block = blockWith({ scale: 2 }); // 400 × 200 on the canvas, centred at (100, 100)
    const { crop, centre } = dragCrop({ handle: { u: 1, v: 0 }, start: { x: 300, y: 100 }, block, sourceSize }, { x: 200, y: 140 });
    expect(crop).toEqual({ x: 0, y: 0, width: 0.75, height: 1 }); // the right quarter is gone; vertical movement is ignored
    expect(centre).toEqual({ x: 50, y: 100 });
    const after = { ...block, crop, placement: { ...block.placement, ...centre } };
    expect(at(after, 10, 20)).toEqual(at(block, 10, 20));
  });

  it('crops the right side of the source when the block is flipped, and keeps rotated content still', () => {
    const block = blockWith({ flipX: true, rotation: Math.PI / 2 });
    // Rotated a quarter turn, the block's "left" edge (u = -100) sits at y = 0; drag it 50 px down.
    const { crop, centre } = dragCrop({ handle: { u: -1, v: 0 }, start: { x: 100, y: 0 }, block, sourceSize }, { x: 100, y: 50 });
    expect(crop!.x).toBeCloseTo(0);
    expect(crop!.width).toBeCloseTo(0.75); // flipped: the block's left edge is the source's right
    const after = { ...block, crop, placement: { ...block.placement, ...centre } };
    const before = at(block, 30, 70);
    const now = at(after, 30, 70);
    expect(now.x).toBeCloseTo(before.x);
    expect(now.y).toBeCloseTo(before.y);
  });

  it('never grows past the source, and an uncropped result is no crop', () => {
    const cropped = { ...blockWith({}), crop: { x: 0.25, y: 0, width: 0.5, height: 1 } };
    const { crop } = dragCrop({ handle: { u: -1, v: -1 }, start: { x: 50, y: 50 }, block: cropped, sourceSize }, { x: -500, y: -500 });
    expect(crop).toEqual({ x: 0, y: 0, width: 0.75, height: 1 });
    const whole = dragCrop({ handle: { u: 1, v: 0 }, start: { x: 150, y: 100 }, block: cropped, sourceSize: sourceSize }, { x: 900, y: 100 });
    expect(whole.crop).toEqual({ x: 0.25, y: 0, width: 0.75, height: 1 });
    const back = dragCrop({ handle: { u: -1, v: 0 }, start: { x: 0, y: 0 }, block: { ...cropped, crop: { x: 0.25, y: 0, width: 0.75, height: 1 } }, sourceSize }, { x: -900, y: 0 });
    expect(back.crop).toBeUndefined();
  });

  it('stops MIN_CROP_PX short of the opposite edge', () => {
    const block = blockWith({});
    const { crop } = dragCrop({ handle: { u: 1, v: 0 }, start: { x: 200, y: 100 }, block, sourceSize }, { x: -900, y: 100 });
    expect(crop!.width * sourceSize.width).toBeCloseTo(MIN_CROP_PX);
  });
});
