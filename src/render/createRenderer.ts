import type { Renderer, RendererKind } from './renderer';
import { WebGL2Renderer } from './webgl2/webgl2Renderer';
import { WebGPURenderer } from './webgpu/webgpuRenderer';

export interface RendererChoice {
  renderer: Renderer;
  /** Why WebGPU wasn't used, if it wasn't. Shown in the HUD. */
  fallbackReason: string | null;
}

/** Reads `?renderer=webgl2` / `?renderer=webgpu` from the URL. */
export function requestedRenderer(search: string): RendererKind | null {
  const value = new URLSearchParams(search).get('renderer');
  return value === 'webgl2' || value === 'webgpu' ? value : null;
}

/**
 * WebGPU when available, WebGL2 otherwise. A canvas can only ever hold one
 * kind of context, so if WebGPU fails after taking the canvas we swap in a
 * fresh canvas element for WebGL2.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  forced: RendererKind | null,
): Promise<RendererChoice & { canvas: HTMLCanvasElement }> {
  let fallbackReason: string | null = forced === 'webgl2' ? 'forced by ?renderer=webgl2' : null;

  if (forced !== 'webgl2') {
    try {
      return { renderer: await WebGPURenderer.create(canvas), fallbackReason: null, canvas };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.warn('WebGPU unavailable, falling back to WebGL2:', fallbackReason);
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  }
  return { renderer: WebGL2Renderer.create(canvas), fallbackReason, canvas };
}
