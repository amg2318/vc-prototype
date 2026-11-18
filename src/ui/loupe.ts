import type { RGB } from '../document/blend';
import { rgbToHex } from './color';

/** Ring shown above the finger/pen while sampling a colour, filled with the sampled colour. */
export class Loupe {
  readonly element: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'loupe';
    this.element.hidden = true;
  }

  show(screen: { x: number; y: number }, color: RGB | null): void {
    this.element.hidden = false;
    // Above the contact point so the finger doesn't hide it.
    this.element.style.transform = `translate(${screen.x - 40}px, ${screen.y - 120}px)`;
    if (color) this.element.style.borderColor = rgbToHex(color);
  }

  hide(): void {
    this.element.hidden = true;
  }
}
