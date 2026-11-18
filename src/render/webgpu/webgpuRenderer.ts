import { CommandQueue, DAB_FLOATS, DAB_HARDNESS, packDabs } from '../commandQueue';
import {
  DOCUMENT_SIZE,
  WORKSPACE_BACKGROUND,
  type Dab,
  type FrameInfo,
  type Renderer,
  type StrokeStyle,
} from '../renderer';
import { DAB_WGSL, DISPLAY_WGSL, MERGE_WGSL } from './shaders';

const DOCUMENT_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MASK_FORMAT: GPUTextureFormat = 'r8unorm';

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;
  readonly documentWidth = DOCUMENT_SIZE;
  readonly documentHeight = DOCUMENT_SIZE;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;

  private readonly queue = new CommandQueue();
  private readonly documentTexture: GPUTexture;
  private readonly strokeTexture: GPUTexture;
  private readonly predictionTexture: GPUTexture;
  private readonly dabPipeline: GPURenderPipeline;
  private readonly mergePipeline: GPURenderPipeline;
  private readonly displayPipeline: GPURenderPipeline;
  private readonly dabBindGroup: GPUBindGroup;
  private readonly mergeBindGroup: GPUBindGroup;
  private readonly displayBindGroup: GPUBindGroup;
  private readonly mergeUniforms: GPUBuffer;
  private readonly displayUniforms: GPUBuffer;
  private dabBuffer: GPUBuffer | null = null;
  private dabStaging = new Float32Array(DAB_FLOATS * 4096);
  private lost = false;

  /** Throws if WebGPU is unavailable or setup fails; the caller falls back to WebGL2. */
  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!('gpu' in navigator) || !navigator.gpu) throw new Error('navigator.gpu is not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not get a webgpu canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    device.pushErrorScope('validation');
    const renderer = new WebGPURenderer(device, context, format);
    const error = await device.popErrorScope();
    if (error) {
      device.destroy();
      throw new Error(`WebGPU setup failed: ${error.message}`);
    }
    return renderer;
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
  ) {
    this.maxCanvasSize = device.limits.maxTextureDimension2D;
    void device.lost.then((info) => {
      this.lost = true;
      if (info.reason !== 'destroyed') this.onLost?.(`WebGPU device lost (${info.message}) — reload the page.`);
    });

    const size = { width: this.documentWidth, height: this.documentHeight };
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.documentTexture = device.createTexture({ label: 'document', size, format: DOCUMENT_FORMAT, usage });
    this.strokeTexture = device.createTexture({ label: 'stroke mask', size, format: MASK_FORMAT, usage });
    this.predictionTexture = device.createTexture({ label: 'prediction mask', size, format: MASK_FORMAT, usage });

    // Dabs: instanced quads, MAX blending so overlapping dabs don't build up.
    const dabModule = device.createShaderModule({ label: 'dab', code: DAB_WGSL });
    const maxBlend: GPUBlendComponent = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
    this.dabPipeline = device.createRenderPipeline({
      label: 'dab',
      layout: 'auto',
      vertex: {
        module: dabModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: DAB_FLOATS * 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
          },
        ],
      },
      fragment: {
        module: dabModule,
        entryPoint: 'fs',
        targets: [{ format: MASK_FORMAT, blend: { color: maxBlend, alpha: maxBlend } }],
      },
      primitive: { topology: 'triangle-strip' },
    });
    const dabUniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(dabUniforms, 0, new Float32Array([this.documentWidth, this.documentHeight, DAB_HARDNESS, 0]));
    this.dabBindGroup = device.createBindGroup({
      layout: this.dabPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: dabUniforms } }],
    });

    // Merge: stroke mask → document with source-over blending.
    const mergeModule = device.createShaderModule({ label: 'merge', code: MERGE_WGSL });
    this.mergePipeline = device.createRenderPipeline({
      label: 'merge',
      layout: 'auto',
      vertex: { module: mergeModule, entryPoint: 'vs' },
      fragment: {
        module: mergeModule,
        entryPoint: 'fs',
        targets: [
          {
            format: DOCUMENT_FORMAT,
            blend: {
              color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.mergeUniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mergeBindGroup = device.createBindGroup({
      layout: this.mergePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.mergeUniforms } },
        { binding: 1, resource: this.strokeTexture.createView() },
      ],
    });

    // Display: document quad through the view matrix, live stroke mixed on top.
    const displayModule = device.createShaderModule({ label: 'display', code: DISPLAY_WGSL });
    this.displayPipeline = device.createRenderPipeline({
      label: 'display',
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.displayUniforms = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.displayBindGroup = device.createBindGroup({
      layout: this.displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.displayUniforms } },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: this.documentTexture.createView() },
        { binding: 3, resource: this.strokeTexture.createView() },
        { binding: 4, resource: this.predictionTexture.createView() },
      ],
    });

    const encoder = device.createCommandEncoder();
    this.clearPass(encoder, this.documentTexture, { r: 1, g: 1, b: 1, a: 1 });
    this.clearPass(encoder, this.strokeTexture, { r: 0, g: 0, b: 0, a: 0 });
    this.clearPass(encoder, this.predictionTexture, { r: 0, g: 0, b: 0, a: 0 });
    device.queue.submit([encoder.finish()]);
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  }

  beginStroke(style: StrokeStyle): void {
    this.queue.beginStroke(style);
  }

  addStrokeDabs(dabs: readonly Dab[]): void {
    this.queue.addDabs(dabs);
  }

  setPredictedDabs(dabs: readonly Dab[]): void {
    this.queue.setPrediction(dabs);
  }

  endStroke(): void {
    this.queue.endStroke();
  }

  clearDocument(): void {
    this.queue.clearDocument();
  }

  render(docToClip: Float32Array): FrameInfo {
    if (this.lost) return { submittedAt: performance.now(), gpuDone: null };
    const device = this.device;

    const commands = this.queue.drain();
    const prediction = this.queue.predictionChanged ? this.queue.predictedDabs : null;
    this.queue.predictionChanged = false;

    const batches = commands.flatMap((c) => (c.kind === 'dabs' ? [c.dabs] : []));
    if (prediction) batches.push(prediction);
    this.uploadDabs(batches);

    let encoder = device.createCommandEncoder();
    let dabOffset = 0;
    for (const command of commands) {
      switch (command.kind) {
        case 'clearStroke':
          this.clearPass(encoder, this.strokeTexture, { r: 0, g: 0, b: 0, a: 0 });
          break;
        case 'dabs':
          this.dabPass(encoder, this.strokeTexture, dabOffset, command.dabs.length);
          dabOffset += command.dabs.length;
          break;
        case 'mergeStroke': {
          // The merge uniform buffer is written per merge, so submit right
          // after it; a second merge in the same frame then sees its own values.
          const { color, opacity } = command.style;
          device.queue.writeBuffer(this.mergeUniforms, 0, new Float32Array([...color, opacity]));
          this.mergePass(encoder);
          device.queue.submit([encoder.finish()]);
          encoder = device.createCommandEncoder();
          break;
        }
        case 'clearDocument':
          this.clearPass(encoder, this.documentTexture, { r: 1, g: 1, b: 1, a: 1 });
          break;
      }
    }
    if (prediction) {
      this.clearPass(encoder, this.predictionTexture, { r: 0, g: 0, b: 0, a: 0 });
      this.dabPass(encoder, this.predictionTexture, dabOffset, prediction.length);
    }

    this.displayPass(encoder, docToClip);
    device.queue.submit([encoder.finish()]);
    const submittedAt = performance.now();
    const gpuDone = device.queue.onSubmittedWorkDone().then(() => performance.now());
    return { submittedAt, gpuDone };
  }

  destroy(): void {
    this.device.destroy();
  }

  // --- passes -------------------------------------------------------------

  private clearPass(encoder: GPUCommandEncoder, texture: GPUTexture, clearValue: GPUColor): void {
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue }],
      })
      .end();
  }

  private dabPass(encoder: GPUCommandEncoder, target: GPUTexture, firstDab: number, count: number): void {
    if (count === 0 || !this.dabBuffer) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.dabPipeline);
    pass.setBindGroup(0, this.dabBindGroup);
    pass.setVertexBuffer(0, this.dabBuffer);
    pass.draw(4, count, 0, firstDab);
    pass.end();
  }

  private mergePass(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.documentTexture.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.mergePipeline);
    pass.setBindGroup(0, this.mergeBindGroup);
    pass.draw(3);
    pass.end();
  }

  private displayPass(encoder: GPUCommandEncoder, m: Float32Array): void {
    const style = this.queue.activeStyle;
    const color = style?.color ?? [0, 0, 0];
    // prettier-ignore
    const uniforms = new Float32Array([
      m[0]!, m[1]!, m[2]!, 0,
      m[3]!, m[4]!, m[5]!, 0,
      m[6]!, m[7]!, m[8]!, 0,
      color[0], color[1], color[2], style?.opacity ?? 0,
      this.documentWidth, this.documentHeight, 0, 0,
    ]);
    this.device.queue.writeBuffer(this.displayUniforms, 0, uniforms);
    const [r, g, b] = WORKSPACE_BACKGROUND;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r, g, b, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.displayPipeline);
    pass.setBindGroup(0, this.displayBindGroup);
    pass.draw(4);
    pass.end();
  }

  // --- resources ----------------------------------------------------------

  private uploadDabs(batches: readonly (readonly Dab[])[]): void {
    const total = batches.reduce((n, b) => n + b.length, 0);
    if (total === 0) return;
    if (this.dabStaging.length < total * DAB_FLOATS) {
      this.dabStaging = new Float32Array(2 ** Math.ceil(Math.log2(total)) * DAB_FLOATS);
    }
    let offset = 0;
    for (const batch of batches) {
      packDabs(batch, this.dabStaging, offset);
      offset += batch.length;
    }
    if (!this.dabBuffer || this.dabBuffer.size < this.dabStaging.byteLength) {
      this.dabBuffer?.destroy();
      this.dabBuffer = this.device.createBuffer({
        label: 'dab instances',
        size: this.dabStaging.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.dabBuffer, 0, this.dabStaging, 0, total * DAB_FLOATS);
  }
}
