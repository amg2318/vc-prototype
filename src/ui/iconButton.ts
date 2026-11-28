/** A 47 × 44 button with a 32 px icon, as used in the drawing page's top bar and tool rail. */
export function iconButton(src: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(src, 32));
  b.addEventListener('click', onClick);
  return b;
}

/** A decorative square image (the button or text next to it carries the meaning). */
export function icon(src: string, size: number): HTMLImageElement {
  const img = Object.assign(document.createElement('img'), { src, alt: '', width: size, height: size, draggable: false });
  img.setAttribute('aria-hidden', 'true');
  return img;
}
