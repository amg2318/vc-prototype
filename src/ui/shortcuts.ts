import type { Tool } from '../tools/tools';

export interface ShortcutActions {
  undo(): void;
  redo(): void;
  selectTool(tool: Tool): void;
  /** Multiply the current tool's size by `factor`. */
  resizeBrush(factor: number): void;
  newLayer(): void;
  toggleHud(): void;
  /** Zoom by `factor` around the middle of the view. */
  zoomBy(factor: number): void;
  zoomToActualSize(): void;
  /** Fit every canvas (⇧1) or the selected canvas (⇧2). */
  fitAll(): void;
  fitSelection(): void;
  /** Save a version of the project (⌘S). */
  saveVersion(): void;
}

/**
 * Desktop keyboard shortcuts:
 *   ⌘/Ctrl+Z undo · ⇧⌘Z or Ctrl+Y redo · B brush · E eraser · I eyedropper
 *   [ / ] brush size · ⇧N new layer (⌘⇧N is taken by browsers) · H toggle HUD
 *   ⌘/Ctrl + = / − / 0 zoom in / out / 100% · ⇧1 fit all canvases · ⇧2 fit the selected canvas
 *   (the zoom keys are the same as Figma's) · ⌘/Ctrl+S save a version
 */
export function installShortcuts(actions: ShortcutActions): void {
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) actions.redo();
      else actions.undo();
      return;
    }
    if (mod && key === 's') {
      e.preventDefault(); // instead of the browser's "save page"
      actions.saveVersion();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      actions.redo();
      return;
    }
    if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) {
      e.preventDefault(); // instead of the browser's page zoom
      if (key === '0') actions.zoomToActualSize();
      else actions.zoomBy(key === '-' ? 1 / 1.5 : 1.5);
      return;
    }
    // Shift+1 / Shift+2 by physical key, since Shift changes the character (! @ on US layouts).
    if (e.shiftKey && !mod && !e.altKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault();
      if (e.code === 'Digit1') actions.fitAll();
      else actions.fitSelection();
      return;
    }
    if (mod || e.altKey) return;

    switch (key) {
      case 'b':
        actions.selectTool('brush');
        break;
      case 'e':
        actions.selectTool('eraser');
        break;
      case 'i':
        actions.selectTool('eyedropper');
        break;
      case '[':
        actions.resizeBrush(1 / 1.15);
        break;
      case ']':
        actions.resizeBrush(1.15);
        break;
      case 'n':
        if (e.shiftKey) actions.newLayer();
        break;
      case 'h':
        actions.toggleHud();
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}

function isTyping(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number')) ||
    target instanceof HTMLTextAreaElement
  );
}
