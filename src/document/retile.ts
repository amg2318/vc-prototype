import { TILE_SIZE } from '../config';
import { containsRect, intersect, type Placement, type Rect } from '../workspace/coords';
import { tileCoords, tileKey, type TileKey, type TileSlot } from './tiles';

/**
 * Resizing a canvas changes its dimensions, not its pixel scale: the canvas
 * grows or shrinks around an anchor and the content stays where it is in the
 * workspace. (anchor 0 = keep the left/top edge, 0.5 = centre, 1 = right/bottom.)
 */
export interface Anchor {
  x: 0 | 0.5 | 1;
  y: 0 | 0.5 | 1;
}

export interface ResizePlan {
  /** New placement in the workspace. */
  placement: Placement;
  /** Where old canvas pixel (0, 0) lands in the new canvas. */
  offsetX: number;
  offsetY: number;
}

export function planResize(old: Placement, width: number, height: number, anchor: Anchor): ResizePlan {
  const offsetX = Math.round((width - old.width) * anchor.x);
  const offsetY = Math.round((height - old.height) * anchor.y);
  return { placement: { x: old.x - offsetX, y: old.y - offsetY, width, height }, offsetX, offsetY };
}

/** Draw old tile `src` with its origin at (dx, dy) relative to the new tile's origin. */
export interface RetileSource {
  src: TileSlot;
  dx: number;
  dy: number;
}

/**
 * GPU work for one new tile: clear it, draw `sources` shifted, then clear
 * everything outside `keep` (tile-local pixels inside the new canvas).
 */
export interface RetileJob {
  key: TileKey;
  dst: TileSlot;
  sources: RetileSource[];
  keep: Rect;
}

export interface LayerRetile {
  /** New tiles that are exactly an old tile: reuse the slot, no GPU work. */
  reused: Map<TileKey, TileSlot>;
  /** New tiles that must be produced on the GPU (dst not yet allocated). */
  jobs: Omit<RetileJob, 'dst'>[];
}

/**
 * Work out a layer's tiles after a resize. Invariant used throughout: pixels
 * outside a canvas are transparent (strokes are clipped to the canvas), so an
 * old tile can be reused as-is when it lands exactly on a new tile and all of
 * its content stays inside the new canvas.
 */
export function retileLayer(tiles: ReadonlyMap<TileKey, TileSlot>, old: Placement, plan: ResizePlan): LayerRetile {
  const reused = new Map<TileKey, TileSlot>();
  const jobs: Omit<RetileJob, 'dst'>[] = [];
  const newCanvas: Rect = { x: 0, y: 0, width: plan.placement.width, height: plan.placement.height };
  const oldCanvasInNew: Rect = { x: plan.offsetX, y: plan.offsetY, width: old.width, height: old.height };

  // Group old tiles by the new tiles they overlap after shifting.
  const sourcesFor = new Map<TileKey, RetileSource[]>();
  for (const [key, src] of tiles) {
    const { tx, ty } = tileCoords(key);
    const shifted: Rect = { x: tx * TILE_SIZE + plan.offsetX, y: ty * TILE_SIZE + plan.offsetY, width: TILE_SIZE, height: TILE_SIZE };
    // Only the part of the tile that holds content (inside the old canvas)
    // and is still inside the new canvas matters.
    const content = intersect(shifted, oldCanvasInNew);
    const kept = content && intersect(content, newCanvas);
    if (!kept) continue; // cropped away entirely
    const nx0 = Math.floor(kept.x / TILE_SIZE);
    const ny0 = Math.floor(kept.y / TILE_SIZE);
    const nx1 = Math.ceil((kept.x + kept.width) / TILE_SIZE);
    const ny1 = Math.ceil((kept.y + kept.height) / TILE_SIZE);
    for (let ny = ny0; ny < ny1; ny++) {
      for (let nx = nx0; nx < nx1; nx++) {
        const newKey = tileKey(nx, ny);
        const list = sourcesFor.get(newKey) ?? [];
        list.push({ src, dx: shifted.x - nx * TILE_SIZE, dy: shifted.y - ny * TILE_SIZE });
        sourcesFor.set(newKey, list);
      }
    }
  }

  for (const [key, sources] of sourcesFor) {
    const { tx, ty } = tileCoords(key);
    const tileRect: Rect = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
    const inCanvas = intersect(tileRect, newCanvas)!;
    // Reuse an old tile when it lands exactly here and none of its content is cropped.
    const only = sources.length === 1 ? sources[0]! : null;
    const aligned = only !== null && only.dx === 0 && only.dy === 0;
    const content = intersect(tileRect, oldCanvasInNew);
    if (aligned && content && containsRect(newCanvas, content)) {
      reused.set(key, only.src);
    } else {
      jobs.push({
        key,
        sources,
        keep: { x: inCanvas.x - tileRect.x, y: inCanvas.y - tileRect.y, width: inCanvas.width, height: inCanvas.height },
      });
    }
  }
  return { reused, jobs };
}
