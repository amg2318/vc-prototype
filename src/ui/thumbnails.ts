import { THUMBNAIL_DELAY_MS, THUMBNAIL_SIZE } from '../config';
import type { Editor } from '../document/editor';
import type { LayerId } from '../document/paintDocument';
import type { Renderer } from '../render/renderer';

/**
 * Keeps one small canvas per layer up to date. Refreshes are debounced
 * (a while after the last change to that layer), so thumbnails never cost
 * anything while drawing.
 */
export class Thumbnails {
  private readonly canvases = new Map<LayerId, HTMLCanvasElement>();
  private readonly timers = new Map<LayerId, number>();

  constructor(
    private readonly editor: Editor,
    private readonly renderer: Renderer,
    private readonly requestFrame: () => void,
  ) {}

  /** The thumbnail canvas for a layer (created on first use). */
  canvasFor(id: LayerId): HTMLCanvasElement {
    let canvas = this.canvases.get(id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_SIZE;
      canvas.height = THUMBNAIL_SIZE;
      canvas.className = 'thumbnail';
      this.canvases.set(id, canvas);
      this.schedule(id, 0);
    }
    return canvas;
  }

  schedule(id: LayerId, delay = THUMBNAIL_DELAY_MS): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, window.setTimeout(() => this.refresh(id), delay));
  }

  private refresh(id: LayerId): void {
    this.timers.delete(id);
    const canvas = this.canvases.get(id);
    if (!canvas || !this.editor.doc.hasLayer(id)) return;
    const tiles = new Map(this.editor.doc.layer(id).tiles);
    void this.renderer.readThumbnail(tiles).then((premultiplied) => {
      // ImageData is straight (not premultiplied) alpha.
      const image = new ImageData(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
      for (let i = 0; i < premultiplied.length; i += 4) {
        const a = premultiplied[i + 3]!;
        const k = a > 0 ? 255 / a : 0;
        image.data[i] = premultiplied[i]! * k;
        image.data[i + 1] = premultiplied[i + 1]! * k;
        image.data[i + 2] = premultiplied[i + 2]! * k;
        image.data[i + 3] = a;
      }
      canvas.getContext('2d')!.putImageData(image, 0, 0);
    });
    this.requestFrame(); // readbacks run during the next frame
  }
}
