import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../config';
import type { Placement } from '../workspace/coords';
import type { BlendMode, RGB } from './blend';
import type { InheritedBlock } from './inheritedBlock';
import type { TileKey, TileSlot } from './tiles';
import type { TileStore } from './tileStore';

export type LayerId = string;
/** Identifies a canvas in the workspace. */
export type CanvasId = string;

export interface LayerProps {
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
}

/**
 * A raster layer: a sparse map from tile key to tile slot. Missing keys are
 * fully transparent. Every entry holds one reference on its slot, so whoever
 * holds the layer (the document, or an undo command for a deleted layer)
 * holds its tiles.
 */
export class RasterLayer implements LayerProps {
  readonly tiles = new Map<TileKey, TileSlot>();
  opacity = 1;
  visible = true;
  blendMode: BlendMode = 'normal';

  constructor(
    readonly id: LayerId,
    public name: string,
  ) {}

  props(): LayerProps {
    return { opacity: this.opacity, visible: this.visible, blendMode: this.blendMode };
  }
}

/** Point `layer`'s tile at `slot` (or remove it), keeping reference counts right. */
export function setLayerTile(store: TileStore, layer: RasterLayer, key: TileKey, slot: TileSlot | null): void {
  const old = layer.tiles.get(key);
  if (slot !== null) {
    store.retain(slot); // retain first, in case slot === old
    layer.tiles.set(key, slot);
  } else {
    layer.tiles.delete(key);
  }
  if (old !== undefined) store.release(old);
}

export function releaseAllTiles(store: TileStore, tiles: Map<TileKey, TileSlot>): void {
  for (const slot of tiles.values()) store.release(slot);
  tiles.clear();
}

/**
 * One canvas: a name, a place in the workspace, a paper colour and a stack of
 * raster layers (index 0 = bottom). Position and size change only through
 * commands, so they can be undone.
 */
export class PaintDocument {
  name: string;
  /** Workspace position of the top-left corner (whole pixels). */
  x = 0;
  y = 0;
  width: number;
  height: number;
  layers: RasterLayer[] = [];
  /** Non-erasable background, below every layer. sRGB 0..1. */
  paper: RGB = [1, 1, 1];
  /** Hidden paper makes the canvas transparent (shown over a checkerboard); inheritors then see only the strokes. */
  paperVisible = true;
  /** Another canvas's composite shown below every layer (Phase 3), or null. Changed only through commands. */
  inherited: InheritedBlock | null = null;
  /** Layers created so far (layer ids are numbered from it; saved, so ids never repeat). */
  layerCounter = 0;

  constructor(
    readonly id: CanvasId,
    readonly store: TileStore,
    size: { width: number; height: number } = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    name = 'Canvas',
  ) {
    this.width = size.width;
    this.height = size.height;
    this.name = name;
  }

  get placement(): Placement {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  createLayer(name?: string): RasterLayer {
    this.layerCounter++;
    return new RasterLayer(`${this.id}:layer-${this.layerCounter}`, name ?? `Layer ${this.layerCounter}`);
  }

  indexOf(id: LayerId): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  layer(id: LayerId): RasterLayer {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) throw new Error(`No layer ${id}`);
    return layer;
  }

  hasLayer(id: LayerId): boolean {
    return this.indexOf(id) >= 0;
  }

  insertLayer(layer: RasterLayer, index: number): void {
    this.layers.splice(index, 0, layer);
  }

  removeLayer(id: LayerId): { layer: RasterLayer; index: number } {
    const index = this.indexOf(id);
    if (index < 0) throw new Error(`No layer ${id}`);
    const [layer] = this.layers.splice(index, 1);
    return { layer: layer!, index };
  }

  /** Adds every tile slot referenced by this canvas's layers to `into`. */
  collectSlots(into: Set<TileSlot>): Set<TileSlot> {
    for (const layer of this.layers) for (const slot of layer.tiles.values()) into.add(slot);
    return into;
  }

  /** Distinct tile slots referenced by layers currently in the document. */
  usedSlotCount(): number {
    return this.collectSlots(new Set()).size;
  }

  /** Tiles allocated across all layers (shared tiles counted once per layer). */
  tileEntryCount(): number {
    return this.layers.reduce((n, l) => n + l.tiles.size, 0);
  }
}
