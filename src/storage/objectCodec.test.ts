import { describe, expect, it } from 'vitest';
import { TILE_BYTES } from '../config';
import {
  OBJECT_HEADER_BYTES,
  crc32,
  decodeAndVerify,
  decodeJson,
  decodeObject,
  encodeJson,
  encodeObject,
  isEmptyTile,
  objectProblem,
  sha256Hex,
} from './objectCodec';

/**
 * A tile of premultiplied pixels with every alpha level and colour values up
 * to that alpha: the semi-transparent pixels a PNG round trip would damage.
 */
function semiTransparentTile(seed = 1): Uint8Array {
  const rgba = new Uint8Array(TILE_BYTES);
  let s = seed;
  const random = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < TILE_BYTES; i += 4) {
    const alpha = (i / 4) % 256; // every alpha level, 0 to 255
    rgba[i] = Math.floor(random() * (alpha + 1));
    rgba[i + 1] = Math.floor(random() * (alpha + 1));
    rgba[i + 2] = Math.floor(random() * (alpha + 1));
    rgba[i + 3] = alpha;
  }
  return rgba;
}

describe('tile objects', () => {
  it('round-trip byte-identical, including semi-transparent pixels', async () => {
    const tile = semiTransparentTile();
    const { bytes } = await encodeObject(tile);
    const back = await decodeObject(bytes);
    expect(back.byteLength).toBe(TILE_BYTES);
    expect(back).toEqual(tile);
  });

  it('are named by the SHA-256 of the raw pixels', async () => {
    const tile = semiTransparentTile();
    const { hash } = await encodeObject(tile);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(tile));
  });

  it('give identical content the same name, and different content a different one', async () => {
    const a = await encodeObject(semiTransparentTile(1));
    const b = await encodeObject(semiTransparentTile(1));
    const c = await encodeObject(semiTransparentTile(2));
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
  });

  it('compress flat tiles to a small fraction', async () => {
    const flat = new Uint8Array(TILE_BYTES);
    for (let i = 0; i < TILE_BYTES; i += 4) flat.set([200, 40, 40, 255], i);
    expect((await encodeObject(flat)).bytes.byteLength).toBeLessThan(2048);
  });
});

describe('damaged objects', () => {
  it('a torn (truncated) write is detected without decompressing', async () => {
    const { bytes } = await encodeObject(semiTransparentTile());
    expect(objectProblem(bytes)).toBeNull();
    expect(objectProblem(bytes.subarray(0, bytes.byteLength - 1))).toMatch(/length/);
    expect(objectProblem(bytes.subarray(0, 10))).toMatch(/header/);
    expect(objectProblem(new Uint8Array(bytes.byteLength))).toMatch(/magic/); // zero-filled file
  });

  it('a flipped byte in the payload fails the CRC', async () => {
    const { bytes } = await encodeObject(semiTransparentTile());
    const copy = bytes.slice();
    copy[OBJECT_HEADER_BYTES + 100]! ^= 0xff;
    expect(objectProblem(copy)).toMatch(/CRC/);
    await expect(decodeObject(copy)).rejects.toThrow(/Damaged/);
  });

  it('decodeAndVerify refuses content that does not match its name', async () => {
    const a = await encodeObject(semiTransparentTile(1));
    const b = await encodeObject(semiTransparentTile(2));
    await expect(decodeAndVerify(a.bytes, a.hash)).resolves.toBeInstanceOf(Uint8Array);
    await expect(decodeAndVerify(a.bytes, b.hash)).rejects.toThrow(/does not match/);
  });
});

describe('helpers', () => {
  it('isEmptyTile is true only for all-zero pixels', () => {
    const tile = new Uint8Array(TILE_BYTES);
    expect(isEmptyTile(tile)).toBe(true);
    tile[TILE_BYTES - 1] = 1;
    expect(isEmptyTile(tile)).toBe(false);
    expect(isEmptyTile(new Uint8Array(7))).toBe(true); // unaligned length takes the byte path
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('JSON objects round-trip', async () => {
    const value = { formatVersion: 1, name: 'Canvas ☺', tiles: { '0,0': 'ab' } };
    const { bytes } = await encodeJson(value);
    expect(await decodeJson(bytes)).toEqual(value);
  });
});
