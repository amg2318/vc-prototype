import { twoFingerTransform, type Vec2, type ViewTransform } from '../viewport/viewport';

/**
 * Two-finger pan / pinch-zoom / optional rotate from touch pointers.
 * One finger does nothing (a resting palm or finger shouldn't move the canvas).
 * A third finger is ignored.
 */
export class TouchNavigator {
  private touches = new Map<number, Vec2>();
  /** Touches we've decided to ignore until they lift (e.g. a palm when the pen landed). */
  private ignored = new Set<number>();
  private gesture: { ids: [number, number]; a0: Vec2; b0: Vec2; startView: ViewTransform; startedAt: number } | null = null;

  allowRotation = false;

  get isNavigating(): boolean {
    return this.gesture !== null;
  }

  down(id: number, p: Vec2, view: ViewTransform, now: number): void {
    if (this.ignored.has(id)) return;
    this.touches.set(id, p);
    if (!this.gesture && this.touches.size === 2) {
      const [[idA, a0], [idB, b0]] = [...this.touches.entries()] as [[number, Vec2], [number, Vec2]];
      this.gesture = { ids: [idA, idB], a0, b0, startView: view, startedAt: now };
    }
  }

  /** Returns the new view if this move changed it. */
  move(id: number, p: Vec2): ViewTransform | null {
    if (!this.touches.has(id)) return null;
    this.touches.set(id, p);
    const g = this.gesture;
    if (!g || !g.ids.includes(id)) return null;
    const a1 = this.touches.get(g.ids[0])!;
    const b1 = this.touches.get(g.ids[1])!;
    return twoFingerTransform(g.startView, g.a0, g.b0, a1, b1, this.allowRotation);
  }

  up(id: number): void {
    this.ignored.delete(id);
    this.touches.delete(id);
    if (this.gesture?.ids.includes(id)) this.gesture = null;
  }

  /**
   * The pen touched down: forget all current touches (they're most likely a
   * palm) and ignore them until they lift. If a gesture was in progress,
   * returns the view from before it so an accidental palm pinch is undone.
   */
  rejectAllForPen(): ViewTransform | null {
    const restore = this.gesture?.startView ?? null;
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    this.gesture = null;
    return restore;
  }
}
