import { describe, expect, it } from 'vitest';
import { unpremultiply } from '../export/canvasPng';
import { thumbnailLayout } from './workspaceThumbnail';

describe('workspace thumbnail', () => {
  it('fits every canvas into the longest side', () => {
    const layout = thumbnailLayout(
      [
        { x: 0, y: 0, width: 1000, height: 500 },
        { x: 1500, y: 0, width: 1000, height: 1000 },
      ],
      250,
    )!;
    expect(layout).toEqual({ width: 250, height: 100, scale: 0.1, x: 0, y: 0 });
    expect(thumbnailLayout([], 250)).toBeNull();
  });

  it('turns premultiplied pixels into straight alpha', () => {
    expect([...unpremultiply(new Uint8Array([64, 32, 0, 128, 9, 9, 9, 0]))]).toEqual([128, 64, 0, 128, 0, 0, 0, 0]);
  });
});
