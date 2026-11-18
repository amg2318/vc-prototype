/** Canvas sizes offered when creating or resizing a canvas (pixels; print sizes at 300 dpi). */
export interface CanvasPreset {
  name: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { name: 'A4 (300 dpi)', width: 2480, height: 3508 },
  { name: 'US Letter (300 dpi)', width: 2550, height: 3300 },
  { name: 'Comic page 6.625 × 10.25 in (300 dpi)', width: 1988, height: 3075 },
  { name: 'Square', width: 2048, height: 2048 },
  { name: '1920 × 1080', width: 1920, height: 1080 },
];
