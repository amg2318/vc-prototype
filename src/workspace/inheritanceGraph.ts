import { linkedSource, type InheritedBlock } from '../document/inheritedBlock';
import type { CanvasId } from '../document/paintDocument';

/** What the graph needs to know about a canvas. */
export interface GraphCanvas {
  id: CanvasId;
  inherited: InheritedBlock | null;
}

/**
 * The arrows between canvases, read from their inherited blocks (so the graph
 * can never disagree with them). Arrows go from source to inheritor. Each
 * canvas has at most one source, so the graph is a forest: every canvas has
 * a depth (0 for a canvas that inherits nothing), and a parent's depth is
 * always smaller than its children's.
 *
 * Built fresh whenever it's needed: it is small, and rebuilding avoids
 * keeping a second copy of the arrows up to date.
 */
export class InheritanceGraph {
  private readonly sources = new Map<CanvasId, CanvasId>();
  private readonly inheritors = new Map<CanvasId, CanvasId[]>();

  /** Only arrows between canvases in `canvases` count (deleted canvases are left out). */
  constructor(canvases: readonly GraphCanvas[]) {
    const ids = new Set(canvases.map((c) => c.id));
    for (const c of canvases) {
      const source = linkedSource(c.inherited);
      if (source === null || !ids.has(source)) continue;
      this.sources.set(c.id, source);
      const list = this.inheritors.get(source) ?? [];
      list.push(c.id);
      this.inheritors.set(source, list);
    }
  }

  sourceOf(id: CanvasId): CanvasId | null {
    return this.sources.get(id) ?? null;
  }

  /** Canvases that inherit `id` directly. */
  inheritorsOf(id: CanvasId): readonly CanvasId[] {
    return this.inheritors.get(id) ?? [];
  }

  /** `id`'s sources, nearest first. */
  upstream(id: CanvasId): CanvasId[] {
    const path: CanvasId[] = [];
    let current = this.sourceOf(id);
    // The size guard only matters if a cycle somehow got in; it stops the walk.
    while (current !== null && path.length <= this.sources.size) {
      path.push(current);
      current = this.sourceOf(current);
    }
    return path;
  }

  /** Every canvas that depends on `id`, directly or through a chain. */
  downstream(id: CanvasId): CanvasId[] {
    const found: CanvasId[] = [];
    const queue = [...this.inheritorsOf(id)];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (found.includes(next)) continue;
      found.push(next);
      queue.push(...this.inheritorsOf(next));
    }
    return found;
  }

  /** Number of arrows between `id` and the root of its chain. */
  depth(id: CanvasId): number {
    return this.upstream(id).length;
  }

  /** The deepest chain in the graph: the largest depth of any canvas (0 if there are no arrows). */
  maxDepth(): number {
    let deepest = 0;
    for (const id of this.sources.keys()) deepest = Math.max(deepest, this.depth(id));
    return deepest;
  }

  /**
   * Would making `target` inherit `source` create a cycle? Walk up from the
   * source through its sources: if the target is reached, the new arrow
   * would close a loop.
   */
  wouldCycle(target: CanvasId, source: CanvasId): boolean {
    return source === target || this.upstream(source).includes(target);
  }

  /**
   * The canvases in `changed` and everything downstream of them, sources
   * before the canvases that inherit them. Sorting by depth is enough: a
   * source is always shallower than its inheritors.
   */
  propagationOrder(changed: Iterable<CanvasId>): CanvasId[] {
    const all = new Set<CanvasId>();
    for (const id of changed) {
      all.add(id);
      for (const d of this.downstream(id)) all.add(d);
    }
    return [...all].sort((a, b) => this.depth(a) - this.depth(b));
  }
}
