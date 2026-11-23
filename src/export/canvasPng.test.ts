import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TILE_BYTES, TILE_SIZE } from '../config';
import { tileCoords } from '../document/tiles';
import { canvasPng } from './canvasPng';

describe('canvasPng', () => {
  it('stitches the composite tiles in order, crops to the canvas and un-premultiplies', async () => {
    const size = { width: TILE_SIZE + 10, height: 2 }; // two tile columns, the second cropped
    const asked: number[][] = [];
    const png = await canvasPng(size, async (keys) => {
      asked.push(keys.map((k) => tileCoords(k).tx));
      // Tile 0: half-transparent red (premultiplied 128,0,0,128); tile 1: opaque blue.
      return keys.map((k) => {
        const t = new Uint8Array(TILE_BYTES);
        for (let i = 0; i < TILE_BYTES; i += 4) t.set(tileCoords(k).tx === 0 ? [128, 0, 0, 128] : [0, 0, 255, 255], i);
        return t;
      });
    });
    expect(asked).toEqual([[0, 1]]);
    // Decode the single IDAT (Sub filter) and look at the first row.
    const idatAt = 8 + 25;
    const length = new DataView(png.buffer).getUint32(idatAt);
    const raw = unzlibSync(png.subarray(idatAt + 8, idatAt + 8 + length));
    const rowBytes = 1 + size.width * 4;
    expect(raw.length).toBe(rowBytes * size.height);
    const row = new Uint8Array(size.width * 4);
    for (let i = 0; i < row.length; i++) row[i] = (raw[1 + i]! + (i >= 4 ? row[i - 4]! : 0)) & 0xff;
    expect([...row.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    expect([...row.subarray(row.length - 4)]).toEqual([0, 0, 255, 255]);
  });
});
