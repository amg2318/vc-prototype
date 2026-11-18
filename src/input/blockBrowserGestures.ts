/**
 * Stop Safari (and other browsers) from treating drawing input as page
 * gestures. CSS (`touch-action: none`, `user-select: none`,
 * `-webkit-touch-callout: none` in style.css) does most of the work; this
 * covers what CSS can't.
 */
export function blockBrowserGestures(canvas: HTMLElement): void {
  const prevent = (e: Event): void => e.preventDefault();
  const active = { passive: false } as const;

  // Safari's proprietary pinch events → page zoom, even with user-scalable=no.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, prevent, active);
  }
  document.addEventListener('contextmenu', prevent);
  document.addEventListener('selectstart', prevent);
  document.addEventListener('dblclick', prevent, active); // double-tap zoom

  // Cancelling touch events on the canvas stops iOS scrolling, the long-press
  // magnifier/selection loupe and double-tap zoom. Pointer events still fire.
  // Only on the canvas, so the debug panel's sliders keep working.
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    canvas.addEventListener(type, prevent, active);
  }
}
