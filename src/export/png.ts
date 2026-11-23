import { Zlib } from 'fflate';
import { crc32 } from '../storage/objectCodec';

/**
 * A minimal PNG encoder: 8-bit RGBA (straight alpha), written row by row
 * into a streaming zlib compressor, so a large canvas never needs all its
 * pixels in memory at once, nor a browser <canvas> of its size (iPad limits
 * canvas area). Each row uses the "Sub" filter (each byte minus the one four
 * bytes before), which compresses drawings much better than no filter.
 */
export class PngWriter {
  private readonly idat: Uint8Array[] = [];
  private readonly zlib: Zlib;
  private rowsWritten = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (!(width > 0 && height > 0)) throw new Error('PNG: empty image');
    this.zlib = new Zlib({ level: 6 }, (chunk) => this.idat.push(chunk));
  }

  /** Add one row of `width` straight-alpha RGBA pixels. */
  addRow(rgba: Uint8Array | Uint8ClampedArray): void {
    if (rgba.length !== this.width * 4) throw new Error('PNG: wrong row length');
    if (this.rowsWritten >= this.height) throw new Error('PNG: too many rows');
    const row = new Uint8Array(1 + rgba.length);
    row[0] = 1; // filter type 1: Sub
    for (let i = 0; i < rgba.length; i++) row[1 + i] = (rgba[i]! - (i >= 4 ? rgba[i - 4]! : 0)) & 0xff;
    this.rowsWritten++;
    this.zlib.push(row, this.rowsWritten === this.height);
  }

  /** The PNG file (after every row was added). */
  finish(): Uint8Array {
    if (this.rowsWritten !== this.height) throw new Error(`PNG: ${this.rowsWritten} of ${this.height} rows`);
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, this.width);
    view.setUint32(4, this.height);
    header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, adaptive filtering, no interlace
    const parts = [PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', concat(this.idat)), chunk('IEND', new Uint8Array(0))];
    return concat(parts);
  }
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
