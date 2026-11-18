import type { RGB } from '../document/blend';
import { hsvToRgb, rgbToHex, rgbToHsv, type HSV } from './color';

const SQUARE_W = 240;
const SQUARE_H = 170;
const HUE_H = 28;

/**
 * HSV colour picker: a saturation/value square, a hue strip and a row of
 * recent colours. Plain DOM + 2D canvas; works with pen, touch and mouse.
 */
export class ColorPicker {
  readonly element: HTMLElement;
  private hsv: HSV = { h: 0, s: 0, v: 0 };
  private readonly square: HTMLCanvasElement;
  private readonly hue: HTMLCanvasElement;
  private readonly recents: HTMLElement;
  private readonly hex: HTMLElement;

  constructor(private readonly onPick: (color: RGB) => void) {
    this.element = document.createElement('div');
    this.element.className = 'color-picker panel';
    this.element.hidden = true;

    this.square = this.canvas('picker-square', SQUARE_W, SQUARE_H);
    this.hue = this.canvas('picker-hue', SQUARE_W, HUE_H);
    this.recents = document.createElement('div');
    this.recents.className = 'picker-recents';
    this.hex = document.createElement('div');
    this.hex.className = 'picker-hex';
    this.element.append(this.square, this.hue, this.hex, this.recents);

    this.drag(this.square, (x, y) => {
      this.hsv = { ...this.hsv, s: x, v: 1 - y };
      this.changed();
    });
    this.drag(this.hue, (x) => {
      this.hsv = { ...this.hsv, h: x * 359.9 };
      this.changed();
    });
    this.drawHue();
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    this.element.hidden = !this.element.hidden;
  }

  close(): void {
    this.element.hidden = true;
  }

  /** Show `color` without reporting it as a pick (e.g. after the eyedropper). */
  setColor(color: RGB): void {
    const hsv = rgbToHsv(color);
    // Keep the current hue for greys, where hue is undefined.
    this.hsv = hsv.s === 0 ? { ...hsv, h: this.hsv.h } : hsv;
    this.draw();
  }

  setRecentColors(colors: readonly RGB[]): void {
    this.recents.replaceChildren(
      ...colors.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.style.background = rgbToHex(c);
        b.setAttribute('aria-label', `Recent colour ${rgbToHex(c)}`);
        b.addEventListener('click', () => {
          this.setColor(c);
          this.onPick(c);
        });
        return b;
      }),
    );
  }

  private changed(): void {
    this.draw();
    this.onPick(hsvToRgb(this.hsv));
  }

  private draw(): void {
    const ctx = this.square.getContext('2d')!;
    const { width: w, height: h } = this.square;
    ctx.fillStyle = rgbToHex(hsvToRgb({ h: this.hsv.h, s: 1, v: 1 }));
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
    this.marker(ctx, this.hsv.s * w, (1 - this.hsv.v) * h);
    this.drawHue();
    this.hex.textContent = rgbToHex(hsvToRgb(this.hsv));
  }

  private drawHue(): void {
    const ctx = this.hue.getContext('2d')!;
    const { width: w, height: h } = this.hue;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, rgbToHex(hsvToRgb({ h: i * 60, s: 1, v: 1 })));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    this.marker(ctx, (this.hsv.h / 360) * w, h / 2);
  }

  private marker(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const r = 8 * (window.devicePixelRatio || 1);
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(x, y, r + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, r - 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  private canvas(className: string, cssWidth: number, cssHeight: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.className = className;
    c.width = cssWidth * dpr;
    c.height = cssHeight * dpr;
    c.style.width = `${cssWidth}px`;
    c.style.height = `${cssHeight}px`;
    return c;
  }

  /** Report the pointer position as 0..1 fractions while dragging on `el`. */
  private drag(el: HTMLElement, onMove: (x: number, y: number) => void): void {
    const report = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      report(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) report(e);
    });
  }
}
