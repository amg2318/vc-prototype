import type { PaintDocument } from '../document/paintDocument';
import type { CompositeState, StrokeStyle } from '../render/renderer';

/**
 * Builds the compositor input from the document: paper, then visible layers
 * bottom to top. Hidden layers are left out entirely (they cost nothing).
 * If a stroke is in progress on a visible layer, it is shown on that layer.
 */
export function buildCompositeState(
  doc: PaintDocument,
  liveStroke: { layerId: string; style: StrokeStyle } | null,
): CompositeState {
  const visible = doc.layers.filter((l) => l.visible);
  const sourceIndex = liveStroke ? visible.findIndex((l) => l.id === liveStroke.layerId) : -1;
  return {
    paper: [...doc.paper],
    sources: visible.map((l) => ({ kind: 'raster', opacity: l.opacity, blendMode: l.blendMode, tiles: l.tiles })),
    liveStroke: liveStroke && sourceIndex >= 0 ? { sourceIndex, style: liveStroke.style } : null,
  };
}
