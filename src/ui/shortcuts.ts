import type { Tool } from '../tools/tools';

export interface ShortcutActions {
  undo(): void;
  redo(): void;
  selectTool(tool: Tool): void;
  /** Multiply the current tool's size by `factor`. */
  resizeBrush(factor: number): void;
  newLayer(): void;
  toggleHud(): void;
}

/**
 * Desktop keyboard shortcuts:
 *   ⌘/Ctrl+Z undo · ⇧⌘Z or Ctrl+Y redo · B brush · E eraser · I eyedropper
 *   [ / ] brush size · ⇧N new layer (⌘⇧N is taken by browsers) · H toggle HUD
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
    if (mod && key === 'y') {
      e.preventDefault();
      actions.redo();
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
