import { PaintDocument, RasterLayer } from '../document/paintDocument';
import { tileCoords, tileKey, type TileId } from '../document/tiles';
import type { TileStore } from '../document/tileStore';
import { FORMAT_VERSION, parseTileMapKey, tileMapKey, type CanvasRecord, type PreviewRecord, type TileMap } from '../storage/format';
import type { ObjectHash } from '../storage/objectCodec';
import type { TileHashes } from './tileHashes';

/**
 * Converting between canvases in memory (layers of tile ids) and saved canvas
 * records (layers of content hashes). Pure: no GPU, no storage.
 */

/** Tiles of these canvases that have no hash yet (they must be read back and saved first). */
export function unhashedTiles(docs: Iterable<PaintDocument>, hashes: TileHashes): Set<TileId> {
  const missing = new Set<TileId>();
  for (const doc of docs) {
    for (const layer of doc.layers) for (const id of layer.tiles.values()) if (!hashes.has(id)) missing.add(id);
  }
  return missing;
}

/**
 * The saved record of a canvas. Every tile must have been hashed (see
 * `unhashedTiles`); empty tiles are left out.
 */
export function canvasRecord(doc: PaintDocument, hashes: TileHashes, previews: PreviewRecord[]): CanvasRecord {
  return {
    formatVersion: FORMAT_VERSION,
    id: doc.id,
    name: doc.name,
    x: doc.x,
    y: doc.y,
    width: doc.width,
    height: doc.height,
    paper: [...doc.paper],
    paperVisible: doc.paperVisible,
    layerCounter: doc.layerCounter,
    layers: doc.layers.map((layer) => {
      const tiles: TileMap = {};
      for (const [key, id] of layer.tiles) {
        const hash = hashes.get(id);
        if (hash === undefined) throw new Error(`Tile ${id} of ${layer.id} has not been saved`);
        if (hash === null) continue; // empty
        const { tx, ty } = tileCoords(key);
        tiles[tileMapKey(tx, ty)] = hash;
      }
      return { id: layer.id, name: layer.name, opacity: layer.opacity, visible: layer.visible, blendMode: layer.blendMode, tiles };
    }),
    inherited: doc.inherited,
    previews,
  };
}

/**
 * A canvas rebuilt from its record. Each tile is adopted by content: ids
 * already in memory are shared, others are new ids whose pixels are on disk
 * (`fresh`, reported so the renderer knows to load them when needed).
 * Returns null if the tile pool is full.
 */
export function canvasFromRecord(
  record: CanvasRecord,
  store: TileStore,
  hashes: TileHashes,
  fresh: (id: TileId, hash: ObjectHash) => void,
): PaintDocument | null {
  const doc = new PaintDocument(record.id, store, { width: record.width, height: record.height }, record.name);
  doc.x = record.x;
  doc.y = record.y;
  doc.paper = [...record.paper];
  doc.paperVisible = record.paperVisible;
  doc.inherited = record.inherited;
  doc.layerCounter = record.layerCounter;
  for (const saved of record.layers) {
    const layer = new RasterLayer(saved.id, saved.name);
    layer.opacity = saved.opacity;
    layer.visible = saved.visible;
    layer.blendMode = saved.blendMode;
    for (const [mapKey, hash] of Object.entries(saved.tiles)) {
      const adopted = hashes.adopt(hash);
      if (!adopted) {
        releaseDoc(doc, store);
        for (const [, id] of layer.tiles) store.release(id);
        return null;
      }
      if (adopted.fresh) fresh(adopted.id, hash);
      const { tx, ty } = parseTileMapKey(mapKey);
      layer.tiles.set(tileKey(tx, ty), adopted.id);
    }
    doc.insertLayer(layer, doc.layers.length);
  }
  return doc;
}

function releaseDoc(doc: PaintDocument, store: TileStore): void {
  for (const layer of doc.layers) for (const id of layer.tiles.values()) store.release(id);
}
