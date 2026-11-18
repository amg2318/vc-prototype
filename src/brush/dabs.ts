/**
 * Dab interpolation: turns a sequence of stroke points into evenly spaced
 * round "dabs" (stamps). Spacing is a fraction of the current dab diameter,
 * so small dabs are placed close together and large dabs further apart, which
 * keeps the stroke edge smooth at every size.
 *
 * The interpolator carries the distance travelled since the last dab across
 * calls, so splitting the same path into more or fewer input points produces
 * (nearly) the same dabs.
 */

export interface Dab {
  /** Document-space centre. */
  x: number;
  y: number;
  /** Document pixels. */
  radius: number;
  /** 0..1, the dab's peak coverage in the stroke mask. */
  opacity: number;
}

/** A point on the stroke path with its dab size/opacity already resolved. */
export type DabPoint = Dab;

/** Never place dabs closer than this (document px), however small the brush. */
export const MIN_SPACING_PX = 0.5;
/** Safety cap so a corrupt jump in input can't freeze the main thread. */
export const MAX_DABS_PER_SEGMENT = 20000;

export function dabSpacing(radius: number, spacingFraction: number): number {
  return Math.max(MIN_SPACING_PX, spacingFraction * 2 * radius);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class DabInterpolator {
  private last: DabPoint | null = null;
  private distanceSinceDab = 0;

  /** @param spacingFraction dab spacing as a fraction of diameter (e.g. 0.15). */
  constructor(private spacingFraction: number) {}

  /** Start a stroke: always emits a dab at the first point. */
  begin(p: DabPoint): Dab[] {
    this.last = { ...p };
    this.distanceSinceDab = 0;
    return [{ ...p }];
  }

  /** Extend the stroke to `p`, returning the dabs placed along the new segment. */
  addPoint(p: DabPoint): Dab[] {
    const a = this.last;
    if (!a) return this.begin(p);

    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const length = Math.hypot(dx, dy);
    const dabs: Dab[] = [];

    if (length > 0) {
      let travelled = 0; // along this segment
      while (dabs.length < MAX_DABS_PER_SEGMENT) {
        const t = travelled / length;
        const spacing = dabSpacing(lerp(a.radius, p.radius, t), this.spacingFraction);
        const needed = Math.max(0, spacing - this.distanceSinceDab);
        if (travelled + needed > length) {
          this.distanceSinceDab += length - travelled;
          break;
        }
        travelled += needed;
        this.distanceSinceDab = 0;
        const u = travelled / length;
        dabs.push({
          x: lerp(a.x, p.x, u),
          y: lerp(a.y, p.y, u),
          radius: lerp(a.radius, p.radius, u),
          opacity: lerp(a.opacity, p.opacity, u),
        });
      }
    }

    this.last = { ...p };
    return dabs;
  }

  clone(): DabInterpolator {
    const copy = new DabInterpolator(this.spacingFraction);
    copy.last = this.last ? { ...this.last } : null;
    copy.distanceSinceDab = this.distanceSinceDab;
    return copy;
  }
}
