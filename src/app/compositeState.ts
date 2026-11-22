import type { PaintDocument } from '../document/paintDocument';
import type { CanvasRenderState, StrokeStyle } from '../render/renderer';

/**
 * Builds the compositor input for one canvas: its placement, paper, then
 * inherited block (if linked and visible), then visible layers bottom to top. Hidden layers are left out entirely (they
 * cost nothing). If a stroke is in progress on a visible layer of this
 * canvas, it is shown on that layer.
 */
export function buildCanvasState(
  doc: PaintDocument,
  liveStroke: { layerId: string; style: StrokeStyle } | null,
): CanvasRenderState {
  const visible = doc.layers.filter((l) => l.visible);
  const sourceIndex = liveStroke ? visible.findIndex((l) => l.id === liveStroke.layerId) : -1;
  return {
    id: doc.id,
    placement: doc.placement,
    paper: [...doc.paper],
    paperVisible: doc.paperVisible,
    sources: visible.map((l) => ({ kind: 'raster', opacity: l.opacity, blendMode: l.blendMode, tiles: l.tiles })),
    liveStroke: liveStroke && sourceIndex >= 0 ? { sourceIndex, style: liveStroke.style } : null,
    inherited: doc.inherited?.visible && doc.inherited.source.kind === 'linked' ? doc.inherited : null,
  };
}
