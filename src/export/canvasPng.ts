import { TILE_SIZE } from '../config';
import { tileKey, type TileKey } from '../document/tiles';
import { PngWriter } from './png';

/**
 * A canvas as a PNG at full resolution: its composite (every visible layer,
 * content inherited through the whole chain, on its paper if the paper is
 * shown), converted to straight alpha since this is a final image.
 *
 * The composite is read a row of tiles at a time (`readTiles`, premultiplied
 * RGBA tiles), so memory holds one tile row however large the canvas is.
 */
export async function canvasPng(
  size: { width: number; height: number },
  readTiles: (keys: readonly TileKey[]) => Promise<(Uint8Array | null)[]>,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const png = new PngWriter(size.width, size.height);
  const cols = Math.ceil(size.width / TILE_SIZE);
  const rows = Math.ceil(size.height / TILE_SIZE);
  const row = new Uint8Array(size.width * 4);
  for (let ty = 0; ty < rows; ty++) {
    const tiles = await readTiles(Array.from({ length: cols }, (_, tx) => tileKey(tx, ty)));
    if (tiles.some((t) => t === null)) throw new Error('The canvas was deleted during the export');
    const height = Math.min(TILE_SIZE, size.height - ty * TILE_SIZE);
    for (let y = 0; y < height; y++) {
      for (let tx = 0; tx < cols; tx++) {
        const width = Math.min(TILE_SIZE, size.width - tx * TILE_SIZE);
        const start = y * TILE_SIZE * 4;
        row.set(tiles[tx]!.subarray(start, start + width * 4), tx * TILE_SIZE * 4);
      }
      png.addRow(unpremultiply(row));
    }
    onProgress?.((ty + 1) / rows);
  }
  return png.finish();
}

/** Premultiplied → straight alpha (rounding to nearest). */
export function unpremultiply(rgba: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 0) continue;
    out[i] = Math.round((rgba[i]! * 255) / a);
    out[i + 1] = Math.round((rgba[i + 1]! * 255) / a);
    out[i + 2] = Math.round((rgba[i + 2]! * 255) / a);
    out[i + 3] = a;
  }
  return out;
}
