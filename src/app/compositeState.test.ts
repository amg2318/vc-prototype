import { describe, expect, it } from 'vitest';
import { Editor } from '../document/editor';
import { TileStore } from '../document/tileStore';
import { buildCompositeState } from './compositeState';

const style = { color: [0, 0, 0] as [number, number, number], opacity: 1, mode: 'paint' as const };

describe('buildCompositeState', () => {
  it('lists visible layers bottom to top and maps the live stroke to its source index', () => {
    const e = new Editor(new TileStore(4));
    e.addLayer();
    e.addLayer();
    const [bottom, middle, top] = e.doc.layers;
    e.setLayerProps(middle!.id, { visible: false });
    e.setLayerProps(top!.id, { blendMode: 'multiply', opacity: 0.5 });
    const state = buildCompositeState(e.doc, { layerId: top!.id, style });
    expect(state.sources).toHaveLength(2);
    expect(state.sources[1]).toMatchObject({ blendMode: 'multiply', opacity: 0.5 });
    expect(state.liveStroke?.sourceIndex).toBe(1);
    expect(buildCompositeState(e.doc, { layerId: bottom!.id, style }).liveStroke?.sourceIndex).toBe(0);
  });

  it('shows no live stroke on a hidden layer', () => {
    const e = new Editor(new TileStore(4));
    e.setLayerProps(e.activeLayerId, { visible: false });
    expect(buildCompositeState(e.doc, { layerId: e.activeLayerId, style }).liveStroke).toBeNull();
  });
});
