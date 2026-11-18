import { DEFAULT_BRUSH, type BrushSettings } from '../brush/brushSettings';
import type { RGB } from '../document/blend';

export type Tool = 'brush' | 'eraser' | 'eyedropper';

const MAX_RECENT_COLORS = 8;

/**
 * The current tool and each tool's settings. Brush and eraser keep separate
 * size/opacity (like most paint apps); the colour belongs to the brush.
 */
export class ToolState {
  current: Tool = 'brush';
  readonly brush: BrushSettings = { ...DEFAULT_BRUSH, color: [...DEFAULT_BRUSH.color] };
  readonly eraser: BrushSettings = { ...DEFAULT_BRUSH, diameter: 48, color: [0, 0, 0] };
  recentColors: RGB[] = [];
  private listeners: (() => void)[] = [];

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  setTool(tool: Tool): void {
    if (tool === this.current) return;
    this.current = tool;
    this.emit();
  }

  /** The brush settings the size/opacity controls edit: the eraser's while erasing, otherwise the brush's. */
  get editableSettings(): BrushSettings {
    return this.current === 'eraser' ? this.eraser : this.brush;
  }

  setColor(color: RGB): void {
    this.brush.color = [...color];
    this.emit();
  }

  /** Remember a colour that was actually used (most recent first, no duplicates). */
  rememberColor(color: RGB): void {
    const same = (c: RGB): boolean => c.every((v, i) => Math.abs(v - color[i]!) < 1 / 512);
    this.recentColors = [[...color] as RGB, ...this.recentColors.filter((c) => !same(c))].slice(0, MAX_RECENT_COLORS);
    this.emit();
  }

  adjustSize(factor: number): void {
    const s = this.editableSettings;
    s.diameter = Math.round(Math.min(400, Math.max(1, s.diameter * factor)));
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
