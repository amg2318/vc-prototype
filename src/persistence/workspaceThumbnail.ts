import type { RGB } from '../document/blend';
import { unpremultiply } from '../export/canvasPng';
import { union, type Placement } from '../workspace/coords';

/**
 * A small PNG of the whole workspace, stored with each version so the
 * history panel can show what it looked like. Drawn on the CPU from each
 * canvas's saved level-4 preview (1/16 resolution), so making one never
 * touches the GPU or loads a layer tile.
 *
 * PNG is fine here: it is a picture for people, not saved content (tiles
 * are never stored this way).
 */

export interface ThumbnailCanvas {
  placement: Placement;
  paper: RGB;
  paperVisible: boolean;
  /** The canvas's level-4 preview tile (256² premultiplied RGBA), or null to draw plain paper. */
  preview: Uint8Array | null;
}

/** Level-4 previews hold one canvas pixel per 16 (see the pyramid planner). */
const PREVIEW_SCALE = 1 / 16;
const PREVIEW_TILE = 256;

/** Where the workspace goes in a thumbnail at most `maxPx` on its longest side. */
export function thumbnailLayout(placements: readonly Placement[], maxPx: number): { width: number; height: number; scale: number; x: number; y: number } | null {
  const all = union(placements);
  if (!all) return null;
  const scale = maxPx / Math.max(all.width, all.height);
  return { width: Math.max(1, Math.round(all.width * scale)), height: Math.max(1, Math.round(all.height * scale)), scale, x: all.x, y: all.y };
}

/** The thumbnail as PNG bytes (browser only: uses a 2D canvas). Null for an empty workspace. */
export async function renderWorkspaceThumbnail(canvases: readonly ThumbnailCanvas[], maxPx: number): Promise<Uint8Array | null> {
  const layout = thumbnailLayout(canvases.map((c) => c.placement), maxPx);
  if (!layout) return null;
  const out = document.createElement('canvas');
  out.width = layout.width;
  out.height = layout.height;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const tile = document.createElement('canvas');
  tile.width = tile.height = PREVIEW_TILE;
  const tileCtx = tile.getContext('2d')!;
  for (const c of canvases) {
    const p = c.placement;
    const dx = (p.x - layout.x) * layout.scale;
    const dy = (p.y - layout.y) * layout.scale;
    const dw = p.width * layout.scale;
    const dh = p.height * layout.scale;
    if (c.paperVisible) {
      ctx.fillStyle = `rgb(${c.paper.map((v) => Math.round(v * 255)).join(',')})`;
      ctx.fillRect(dx, dy, dw, dh);
    }
    if (!c.preview) continue;
    tileCtx.putImageData(new ImageData(unpremultiply(c.preview), PREVIEW_TILE, PREVIEW_TILE), 0, 0);
    const sw = Math.min(PREVIEW_TILE, Math.ceil(p.width * PREVIEW_SCALE));
    const sh = Math.min(PREVIEW_TILE, Math.ceil(p.height * PREVIEW_SCALE));
    ctx.drawImage(tile, 0, 0, sw, sh, dx, dy, dw, dh);
  }
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
