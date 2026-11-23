import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../storage/objectCodec';
import { PngWriter } from './png';

/** Decode what PngWriter writes (one IDAT chunk, Sub filter) back to RGBA, checking every chunk's CRC. */
function decode(png: Uint8Array): { width: number; height: number; rgba: Uint8Array; chunks: string[] } {
  const view = new DataView(png.buffer, png.byteOffset);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: string[] = [];
  let at = 8;
  let width = 0;
  let height = 0;
  let idat: Uint8Array = new Uint8Array(0);
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push(type);
    if (type === 'IHDR') [width, height] = [view.getUint32(at + 8), view.getUint32(at + 12)];
    if (type === 'IDAT') idat = data;
    at += 12 + length;
  }
  const raw = unzlibSync(idat);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (1 + width * 4), (y + 1) * (1 + width * 4));
    expect(row[0]).toBe(1);
    for (let i = 0; i < width * 4; i++) rgba[y * width * 4 + i] = (row[1 + i]! + (i >= 4 ? rgba[y * width * 4 + i - 4]! : 0)) & 0xff;
  }
  return { width, height, rgba, chunks };
}

describe('PngWriter', () => {
  it('writes a valid PNG whose pixels decode back exactly', () => {
    const width = 3;
    const height = 2;
    const pixels = new Uint8Array(width * height * 4).map((_, i) => (i * 37) % 256);
    const writer = new PngWriter(width, height);
    for (let y = 0; y < height; y++) writer.addRow(pixels.subarray(y * width * 4, (y + 1) * width * 4));
    const decoded = decode(writer.finish());
    expect(decoded.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect(decoded.rgba).toEqual(pixels);
  });

  it('refuses a short image', () => {
    const writer = new PngWriter(1, 2);
    writer.addRow(new Uint8Array(4));
    expect(() => writer.finish()).toThrow(/1 of 2 rows/);
  });
});
