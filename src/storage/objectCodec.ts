import { deflate, inflate } from './compression';

/**
 * How content-addressed objects (layer tiles, preview tiles, canvas records)
 * are stored on disk.
 *
 * An object is named by the SHA-256 of its *raw* bytes (for a tile: the
 * premultiplied RGBA exactly as it was on the GPU), so identical content gets
 * the same name wherever it appears, and deduplication is just "does a valid
 * file with this name exist?". The stored bytes are a small header followed
 * by the raw bytes, deflate-compressed. Deflate is lossless, so decoding gives
 * back the raw bytes exactly.
 *
 * Why a header with a CRC: a write interrupted by a crash can leave a torn
 * file under the final name (OPFS has no rename we can rely on in Safari). A
 * file only counts as present if its header, length and CRC all check out,
 * so a torn file is rewritten by the next save instead of being trusted.
 *
 * Header (24 bytes, little-endian):
 *   0  magic "VCOB"
 *   4  u16 header format (1)
 *   6  u16 codec (1 = deflate-raw)
 *   8  u32 raw length
 *  12  u32 payload length
 *  16  u32 CRC32 of the payload
 *  20  u32 reserved (0)
 */

export const OBJECT_HEADER_BYTES = 24;
const MAGIC = 0x424f4356; // "VCOB" read as a little-endian u32
const HEADER_FORMAT = 1;
const CODEC_DEFLATE_RAW = 1;

/** SHA-256 hex digest: 64 lowercase hex characters. */
export type ObjectHash = string;

export interface EncodedObject {
  hash: ObjectHash;
  /** Header + compressed payload, ready to write. */
  bytes: Uint8Array;
}

/** SHA-256 of `raw` as lowercase hex (Web Crypto: native, and available in workers and Node). */
export async function sha256Hex(raw: Uint8Array): Promise<ObjectHash> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function isObjectHash(value: unknown): value is ObjectHash {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** True if every byte is zero: a fully transparent premultiplied tile. Such tiles are never stored. */
export function isEmptyTile(rgba: Uint8Array): boolean {
  // Check 32 bits at a time where the buffer allows it (tiles are 256 KB).
  if (rgba.byteOffset % 4 === 0 && rgba.byteLength % 4 === 0) {
    const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
    for (let i = 0; i < words.length; i++) if (words[i] !== 0) return false;
    return true;
  }
  for (let i = 0; i < rgba.length; i++) if (rgba[i] !== 0) return false;
  return true;
}

/** Hash and compress raw bytes into a stored object. */
export async function encodeObject(raw: Uint8Array): Promise<EncodedObject> {
  const [hash, payload] = await Promise.all([sha256Hex(raw), deflate(raw)]);
  const bytes = new Uint8Array(OBJECT_HEADER_BYTES + payload.byteLength);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint16(4, HEADER_FORMAT, true);
  header.setUint16(6, CODEC_DEFLATE_RAW, true);
  header.setUint32(8, raw.byteLength, true);
  header.setUint32(12, payload.byteLength, true);
  header.setUint32(16, crc32(payload), true);
  bytes.set(payload, OBJECT_HEADER_BYTES);
  return { hash, bytes };
}

/**
 * Why stored bytes are not a valid object, or null if they are. Checks the
 * header, the length and the CRC (cheap); it doesn't decompress.
 */
export function objectProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength < OBJECT_HEADER_BYTES) return 'shorter than the header';
  const header = new DataView(bytes.buffer, bytes.byteOffset, OBJECT_HEADER_BYTES);
  if (header.getUint32(0, true) !== MAGIC) return 'bad magic number';
  if (header.getUint16(4, true) !== HEADER_FORMAT) return 'unknown header format';
  if (header.getUint16(6, true) !== CODEC_DEFLATE_RAW) return 'unknown codec';
  const payloadLength = header.getUint32(12, true);
  if (bytes.byteLength !== OBJECT_HEADER_BYTES + payloadLength) return 'wrong length (torn write?)';
  if (crc32(bytes.subarray(OBJECT_HEADER_BYTES)) !== header.getUint32(16, true)) return 'CRC mismatch';
  return null;
}

/** The raw bytes of a stored object. Throws if it is damaged. */
export async function decodeObject(bytes: Uint8Array): Promise<Uint8Array> {
  const problem = objectProblem(bytes);
  if (problem) throw new Error(`Damaged object: ${problem}`);
  const rawLength = new DataView(bytes.buffer, bytes.byteOffset, OBJECT_HEADER_BYTES).getUint32(8, true);
  const raw = await inflate(bytes.subarray(OBJECT_HEADER_BYTES));
  if (raw.byteLength !== rawLength) throw new Error('Damaged object: wrong raw length');
  return raw;
}

/**
 * Decode and also check that the content still has the hash it is named by
 * (used on import, where files come from outside the app).
 */
export async function decodeAndVerify(bytes: Uint8Array, expected: ObjectHash): Promise<Uint8Array> {
  const raw = await decodeObject(bytes);
  if ((await sha256Hex(raw)) !== expected) throw new Error(`Object ${expected.slice(0, 12)}… does not match its hash`);
  return raw;
}

// --- JSON objects (canvas records) ------------------------------------------

export function encodeJson(value: unknown): Promise<EncodedObject> {
  return encodeObject(new TextEncoder().encode(JSON.stringify(value)));
}

export async function decodeJson<T>(bytes: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decodeObject(bytes))) as T;
}

// --- CRC32 (IEEE 802.3, the one zip uses) -----------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
