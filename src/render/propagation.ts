import { inheritorDirtyRect, type InheritedBlock, type Size } from '../document/inheritedBlock';
import type { CanvasId } from '../document/paintDocument';
import { InheritanceGraph } from '../workspace/inheritanceGraph';
import { union, type Rect } from '../workspace/coords';

/** What propagation needs to know about a canvas. */
export interface PropagationCanvas {
  id: CanvasId;
  size: Size;
  /** The block this canvas draws (linked and visible), or null. */
  inherited: InheritedBlock | null;
}

export interface CompositeChange {
  canvasId: CanvasId;
  /** Changed area in that canvas's pixels. */
  rect: Rect;
  /** True if the change came down an arrow rather than from the canvas itself. */
  inherited: boolean;
}

/**
 * Update propagation through the inheritance graph. Pure, so it is unit-tested.
 *
 * Given the areas that changed in some canvases this frame, works out what
 * changes in every canvas that inherits them, directly or through a chain.
 * Each source's change is mapped through its inheritors' crop and placement,
 * and the inheritors are visited sources-first, so a canvas has collected
 * every change from upstream before it passes its own on.
 */
export class Propagation {
  private graph: InheritanceGraph;
  private byId = new Map<CanvasId, PropagationCanvas>();

  constructor(canvases: readonly PropagationCanvas[] = []) {
    this.graph = new InheritanceGraph([]);
    this.setCanvases(canvases);
  }

  setCanvases(canvases: readonly PropagationCanvas[]): void {
    this.byId = new Map(canvases.map((c) => [c.id, c]));
    this.graph = new InheritanceGraph(canvases);
  }

  /** The arrows that are drawn (linked, visible blocks). */
  get arrows(): InheritanceGraph {
    return this.graph;
  }

  /**
   * Every canvas whose composite changes, sources before inheritors, with
   * one merged rectangle each.
   */
  propagate(changed: ReadonlyMap<CanvasId, Rect>): CompositeChange[] {
    const rects = new Map<CanvasId, Rect>(changed);
    const out: CompositeChange[] = [];
    for (const id of this.graph.propagationOrder(changed.keys())) {
      const rect = rects.get(id);
      const source = this.byId.get(id);
      if (!rect || !source) continue;
      out.push({ canvasId: id, rect, inherited: !changed.has(id) });
      for (const inheritorId of this.graph.inheritorsOf(id)) {
        const inheritor = this.byId.get(inheritorId)!;
        const mapped = inheritorDirtyRect(inheritor.inherited!, source.size, inheritor.size, rect);
        if (!mapped) continue;
        const previous = rects.get(inheritorId);
        rects.set(inheritorId, previous ? union([previous, mapped])! : mapped);
      }
    }
    return out;
  }
}
