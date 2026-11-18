import { describe, expect, it } from 'vitest';
import { singleCanvasEditor } from '../workspace/workspace';
import { TileStore } from '../document/tileStore';
import { buildCanvasState } from './compositeState';

const style = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };

describe('buildCanvasState', () => {
  it('lists visible layers bottom to top and maps the live stroke to its source index', () => {
    const e = singleCanvasEditor(new TileStore(4));
    e.addLayer();
    e.addLayer();
    const [bottom, middle, top] = e.doc.layers;
    e.setLayerProps(middle!.id, { visible: false });
    e.setLayerProps(top!.id, { blendMode: 'multiply', opacity: 0.5 });
    const state = buildCanvasState(e.doc, { layerId: top!.id, style });
    expect(state.sources).toHaveLength(2);
    expect(state.sources[1]).toMatchObject({ blendMode: 'multiply', opacity: 0.5 });
    expect(state.liveStroke?.sourceIndex).toBe(1);
    expect(buildCanvasState(e.doc, { layerId: bottom!.id, style }).liveStroke?.sourceIndex).toBe(0);
  });

  it('shows no live stroke on a hidden layer', () => {
    const e = singleCanvasEditor(new TileStore(4));
    e.setLayerProps(e.activeLayerId, { visible: false });
    expect(buildCanvasState(e.doc, { layerId: e.activeLayerId, style }).liveStroke).toBeNull();
  });
});
