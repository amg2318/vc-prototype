import type { Dab } from '../brush/dabs';

export type { Dab };

export type RendererKind = 'webgpu' | 'webgl2';

export interface StrokeStyle {
  /** sRGB 0..1. */
  color: [number, number, number];
  /** Applied once to the whole stroke mask when compositing. */
  opacity: number;
}

export interface FrameInfo {
  /** performance.now() right after the frame's GPU work was submitted. */
  submittedAt: number;
  /**
   * Resolves with performance.now() when the GPU reports the submitted work
   * as done (WebGPU `onSubmittedWorkDone`). Null when the backend can't tell.
   */
  gpuDone: Promise<number> | null;
}

/**
 * The narrow interface the rest of the app draws through.
 *
 * Model: one document texture, plus a "stroke mask" holding the stroke in
 * progress and a "prediction mask" for predicted samples. Dabs are written
 * into the masks with MAX blending, so overlapping dabs don't build up
 * opacity; the mask is composited onto the document once, on `endStroke`.
 *
 * Mutating calls only queue work; nothing touches the GPU until `render()`,
 * which runs once per animation frame, so GPU work is batched per frame no
 * matter how many input events arrived.
 */
export interface Renderer {
  readonly kind: RendererKind;
  readonly documentWidth: number;
  readonly documentHeight: number;
  /** Largest canvas backing size the device supports. */
  readonly maxCanvasSize: number;
  /** Called if the GPU device/context is lost; the app shows the message. */
  onLost: ((message: string) => void) | null;

  /** Resize the canvas backing store (device pixels). */
  resize(pixelWidth: number, pixelHeight: number): void;

  beginStroke(style: StrokeStyle): void;
  addStrokeDabs(dabs: readonly Dab[]): void;
  /** Replace the temporary predicted dabs (pass [] to clear them). */
  setPredictedDabs(dabs: readonly Dab[]): void;
  /** Composite the stroke into the document. */
  endStroke(): void;
  /** Fill the document with white. */
  clearDocument(): void;

  /** Execute queued work and draw the view. `docToClip` comes from viewport/docToClipMatrix. */
  render(docToClip: Float32Array): FrameInfo;
  destroy(): void;
}

export const DOCUMENT_SIZE = 2048;
export const WORKSPACE_BACKGROUND: [number, number, number] = [0.17, 0.17, 0.18];
