import {
  ATLAS_PAGE_SIZE,
  COMPOSITE_LEVEL0_PAGES,
  MAX_ATLAS_PAGES,
  PAGE_BYTES,
  THUMBNAIL_SIZE,
  TILE_COUNT,
  TILE_SIZE,
} from '../../config';
import type { CanvasId } from '../../document/paintDocument';
import { slotLocation, type TileKey, type TileSlot } from '../../document/tiles';
import {
  EMPTY_CHECK_BATCH,
  EMPTY_CHECK_BLOCK,
  MAX_SOURCES,
  MERGE_INSTANCE_FLOATS,
  emptyTilesFromReadback,
  groupByDstPage,
  packCompositeUniforms,
  packMergeInstance,
  packThumbnailInstances,
} from '../compositePacking';
import { DAB_FLOATS, DAB_HARDNESS, ensureCapacity, packDabs, type FrameOp, type Readback } from '../frameQueue';
import type {
  CanvasRenderState,
  Dab,
  FrameInfo,
  MergeJob,
  OverlayRect,
  Renderer,
  RendererMemory,
  RetileJob,
  Rgba8,
  StrokeStyle,
  ViewState,
} from '../renderer';
import {
  COMPOSITE_INSTANCE_FLOATS,
  DOWNSAMPLE_INSTANCE_FLOATS,
  RenderCore,
  SOLID_QUAD_FLOATS,
  TILE_QUAD_FLOATS,
  type Frame,
} from '../renderCore';
import { WORKSPACE_BACKGROUND } from '../workspace';
import {
  COMPOSITE_WGSL,
  DAB_WGSL,
  DISPLAY_WGSL,
  DOWNSAMPLE_WGSL,
  EMPTY_CHECK_WGSL,
  MASK_SIZE,
  MERGE_WGSL,
  SOLID_WGSL,
  THUMBNAIL_WGSL,
} from './shaders';

const TILE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MASK_FORMAT: GPUTextureFormat = 'r8unorm';
const EMPTY_TARGET_WIDTH = EMPTY_CHECK_BATCH * EMPTY_CHECK_BLOCK;
const LOOKUP_BYTES = TILE_COUNT * MAX_SOURCES * 4;

/** Dynamic vertex buffer that grows to fit. */
class GrowableBuffer {
  buffer: GPUBuffer | null = null;
  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
  ) {}

  upload(data: Float32Array, floats = data.length): GPUBuffer {
    const bytes = Math.max(16, floats * 4);
    if (!this.buffer || this.buffer.size < bytes) {
      this.buffer?.destroy();
      this.buffer = this.device.createBuffer({
        label: this.label,
        size: 2 ** Math.ceil(Math.log2(bytes)),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (floats > 0) this.device.queue.writeBuffer(this.buffer, 0, data, 0, floats);
    return this.buffer;
  }
}

/** A growable set of atlas page textures. */
class Pages {
  readonly textures: GPUTexture[] = [];
  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    private readonly max: number,
  ) {}

  /** Returns true if pages were added. */
  ensure(count: number): boolean {
    if (count > this.max) throw new Error(`${this.label}: ${count} > ${this.max} pages`);
    if (count <= this.textures.length) return false;
    while (this.textures.length < count) {
      this.textures.push(
        this.device.createTexture({
          label: `${this.label} ${this.textures.length}`,
          size: [ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE],
          format: TILE_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        }),
      );
    }
    return true;
  }
}

/** Compositor inputs of one canvas: uniforms and tile lookup, plus their bind group. */
interface CanvasGpu {
  uniforms: GPUBuffer;
  lookup: GPUTexture;
  bindGroup: GPUBindGroup | null;
}

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;

  private readonly core = new RenderCore();
  private lost = false;

  private readonly layerPages: Pages;
  private readonly level0Pages: Pages;
  private readonly previewPages: Pages;
  private readonly dummyPage: GPUTexture;
  private readonly strokeMask: GPUTexture;
  private readonly predictionMask: GPUTexture;
  private readonly zeroTile: GPUTexture;
  private readonly scratchTile: GPUTexture;
  private readonly emptyTarget: GPUTexture;
  private readonly thumbTarget: GPUTexture;
  private readonly canvasFormat: GPUTextureFormat;

  private readonly dabPipeline: GPURenderPipeline;
  private readonly mergePipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly downsamplePipeline: GPURenderPipeline;
  private readonly displayPipeline: GPURenderPipeline;
  private readonly solidPipeline: GPURenderPipeline;
  private readonly emptyPipeline: GPURenderPipeline;
  private readonly thumbPipeline: GPURenderPipeline;

  private readonly linearSampler: GPUSampler;
  private readonly dabBindGroup: GPUBindGroup;
  private readonly mergeBindGroup: GPUBindGroup;
  private readonly emptyUniformBindings: GPUBuffer;
  private readonly thumbUniformBindings: GPUBuffer;
  private emptyBindGroup!: GPUBindGroup;
  private thumbBindGroup!: GPUBindGroup;
  private downsampleBindGroup!: GPUBindGroup;
  private displayBindGroups = new Map<string, GPUBindGroup>();
  private readonly canvasGpu = new Map<CanvasId, CanvasGpu>();

  private readonly dabBuffer: GrowableBuffer;
  private readonly mergeBuffer: GrowableBuffer;
  private readonly compositeBuffer: GrowableBuffer;
  private readonly downsampleBuffer: GrowableBuffer;
  private readonly tileQuadBuffer: GrowableBuffer;
  private readonly solidBuffer: GrowableBuffer;
  private dabStaging = new Float32Array(4096);
  private mergeStaging = new Float32Array(1024);

  /** GPU timing of the composite passes, if the device supports timestamp queries. */
  private readonly timestamps: { query: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null;

  /** Throws if WebGPU is unavailable or setup fails; the caller falls back to WebGL2. */
  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!('gpu' in navigator) || !navigator.gpu) throw new Error('navigator.gpu is not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const wantTimestamps = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({
      requiredFeatures: wantTimestamps ? ['timestamp-query'] : [],
    });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not get a webgpu canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    // COPY_SRC lets the eyedropper read what is on screen.
    context.configure({
      device, format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    const renderer = new WebGPURenderer(device, context, format, wantTimestamps);
    const oom = await device.popErrorScope();
    const invalid = await device.popErrorScope();
    const error = oom ?? invalid;
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
    timestampsSupported: boolean,
  ) {
    this.canvasFormat = canvasFormat;
    this.maxCanvasSize = device.limits.maxTextureDimension2D;
    void device.lost.then((info) => {
      this.lost = true;
      if (info.reason !== 'destroyed') this.onLost?.(`WebGPU device lost (${info.message}) — reload the page.`);
    });
    device.onuncapturederror = (e) => console.error('WebGPU error:', e.error.message);

    const T = GPUTextureUsage;
    this.layerPages = new Pages(device, 'layer page', MAX_ATLAS_PAGES);
    this.level0Pages = new Pages(device, 'composite page', COMPOSITE_LEVEL0_PAGES);
    this.previewPages = new Pages(device, 'preview page', Number.MAX_SAFE_INTEGER);
    this.dummyPage = device.createTexture({ label: 'dummy page', size: [1, 1], format: TILE_FORMAT, usage: T.TEXTURE_BINDING });
    const maskUsage = T.RENDER_ATTACHMENT | T.TEXTURE_BINDING;
    const maskSize = [MASK_SIZE, MASK_SIZE];
    this.strokeMask = device.createTexture({ label: 'stroke mask', size: maskSize, format: MASK_FORMAT, usage: maskUsage });
    this.predictionMask = device.createTexture({ label: 'prediction mask', size: maskSize, format: MASK_FORMAT, usage: maskUsage });
    // Textures start zeroed in WebGPU, so this is a transparent tile to copy from.
    this.zeroTile = device.createTexture({ label: 'zero tile', size: [TILE_SIZE, TILE_SIZE], format: TILE_FORMAT, usage: T.COPY_SRC });
    this.scratchTile = device.createTexture({
      label: 'scratch tile', size: [TILE_SIZE, TILE_SIZE], format: TILE_FORMAT, usage: T.COPY_SRC | T.COPY_DST,
    });
    this.emptyTarget = device.createTexture({
      label: 'empty check', size: [EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK], format: TILE_FORMAT,
      usage: T.RENDER_ATTACHMENT | T.COPY_SRC,
    });
    this.thumbTarget = device.createTexture({
      label: 'thumbnail', size: [THUMBNAIL_SIZE, THUMBNAIL_SIZE], format: TILE_FORMAT,
      usage: T.RENDER_ATTACHMENT | T.COPY_SRC,
    });

    const replace: GPUBlendState = {
      color: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
      alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
    };
    const premultipliedOver: GPUBlendState = {
      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const max: GPUBlendComponent = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
    const pipeline = (
      label: string,
      code: string,
      format: GPUTextureFormat,
      blend: GPUBlendState | undefined,
      vec4s: number,
      stride = vec4s * 16,
    ): GPURenderPipeline => {
      const module = device.createShaderModule({ label, code });
      const attributes: GPUVertexAttribute[] = Array.from({ length: vec4s }, (_, i) => ({
        shaderLocation: i, offset: i * 16, format: 'float32x4',
      }));
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: vec4s > 0 ? [{ arrayStride: stride, stepMode: 'instance', attributes }] : [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format, ...(blend ? { blend } : {}) }] },
        primitive: { topology: 'triangle-strip' },
      });
    };

    this.dabPipeline = pipeline('dab', DAB_WGSL, MASK_FORMAT, { color: max, alpha: max }, 1, DAB_FLOATS * 4);
    this.mergePipeline = pipeline('merge', MERGE_WGSL, TILE_FORMAT, premultipliedOver, 3, MERGE_INSTANCE_FLOATS * 4);
    this.compositePipeline = pipeline('composite', COMPOSITE_WGSL, TILE_FORMAT, replace, 1, COMPOSITE_INSTANCE_FLOATS * 4);
    this.downsamplePipeline = pipeline('downsample', DOWNSAMPLE_WGSL, TILE_FORMAT, replace, 3, DOWNSAMPLE_INSTANCE_FLOATS * 4);
    this.displayPipeline = pipeline('display', DISPLAY_WGSL, canvasFormat, premultipliedOver, 4, TILE_QUAD_FLOATS * 4);
    this.solidPipeline = pipeline('solid', SOLID_WGSL, canvasFormat, premultipliedOver, 3, SOLID_QUAD_FLOATS * 4);
    this.emptyPipeline = device.createRenderPipeline({
      label: 'empty check',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: EMPTY_CHECK_WGSL }), entryPoint: 'vs',
        buffers: [{ arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32' }] }],
      },
      fragment: { module: device.createShaderModule({ code: EMPTY_CHECK_WGSL }), entryPoint: 'fs', targets: [{ format: TILE_FORMAT }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.thumbPipeline = pipeline('thumbnail', THUMBNAIL_WGSL, TILE_FORMAT, replace, 1);

    const uniform = (size: number, data?: Float32Array): GPUBuffer => {
      const buffer = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      if (data) device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    };
    const dabUniforms = uniform(16, new Float32Array([MASK_SIZE, MASK_SIZE, DAB_HARDNESS, 0]));
    this.emptyUniformBindings = uniform(16, new Float32Array([EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK, 0, 0]));
    this.thumbUniformBindings = uniform(16, new Float32Array([THUMBNAIL_SIZE, THUMBNAIL_SIZE, 0, 0]));
    this.linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.dabBindGroup = device.createBindGroup({
      layout: this.dabPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: dabUniforms } }],
    });
    this.mergeBindGroup = device.createBindGroup({
      layout: this.mergePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.strokeMask.createView() }],
    });
    this.level0Pages.ensure(1); // scratch tiles live on page 0
    this.rebuildLayerBindGroups();
    this.rebuildCompositeBindGroups();

    this.dabBuffer = new GrowableBuffer(device, 'dab instances');
    this.mergeBuffer = new GrowableBuffer(device, 'merge instances');
    this.compositeBuffer = new GrowableBuffer(device, 'composite instances');
    this.downsampleBuffer = new GrowableBuffer(device, 'downsample instances');
    this.tileQuadBuffer = new GrowableBuffer(device, 'display tile quads');
    this.solidBuffer = new GrowableBuffer(device, 'display solid quads');

    this.timestamps = timestampsSupported
      ? {
          query: device.createQuerySet({ type: 'timestamp', count: 2 }),
          resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
          busy: false,
        }
      : null;

    const encoder = device.createCommandEncoder();
    this.clearPass(encoder, this.strokeMask);
    this.clearPass(encoder, this.predictionMask);
    device.queue.submit([encoder.finish()]);
  }

  memory(): RendererMemory {
    const compositePages = this.level0Pages.textures.length + this.previewPages.textures.length;
    const masks = MASK_SIZE * MASK_SIZE * 2;
    return {
      layerPages: this.layerPages.textures.length,
      compositePages,
      bytes: (this.layerPages.textures.length + compositePages) * PAGE_BYTES + masks + this.canvasGpu.size * LOOKUP_BYTES,
    };
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  }

  setCanvases(canvases: readonly CanvasRenderState[]): void {
    this.core.setCanvases(canvases);
  }

  invalidateTiles(canvasId: CanvasId, keys: readonly TileKey[] | 'all'): void {
    this.core.invalidate(canvasId, keys);
  }

  setOverlay(rects: readonly OverlayRect[]): void {
    this.core.setOverlay(rects);
  }

  beginStroke(canvasId: CanvasId): void {
    this.core.beginStroke(canvasId);
  }

  addStrokeDabs(dabs: readonly Dab[]): void {
    this.core.addDabs(dabs);
  }

  setPredictedDabs(dabs: readonly Dab[]): void {
    this.core.setPrediction(dabs);
  }

  mergeStroke(canvasId: CanvasId, jobs: readonly MergeJob[], style: StrokeStyle): void {
    this.ensureLayerPages(jobs.map((j) => j.dst));
    this.core.merge(canvasId, jobs, style);
  }

  retile(canvasId: CanvasId, jobs: readonly RetileJob[]): void {
    this.ensureLayerPages(jobs.map((j) => j.dst));
    this.core.retile(jobs);
    this.core.invalidate(canvasId, 'all');
  }

  readScreenPixel(x: number, y: number): Promise<Rgba8> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'screenPixel', x, y, resolve }));
  }

  findEmptyTiles(slots: readonly TileSlot[]): Promise<boolean[]> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'empty', slots: [...slots], resolve }));
  }

  readThumbnail(tiles: ReadonlyMap<TileKey, TileSlot>): Promise<Uint8Array> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'thumbnail', tiles: [...tiles], resolve }));
  }

  render(view: ViewState): FrameInfo {
    const idle = { submittedAt: performance.now(), gpuDone: null, compositedTiles: 0, downsampledTiles: 0, visibleCanvases: 0, compositeCpuMs: 0 };
    if (this.lost) return idle;
    const device = this.device;
    const canvas = this.context.canvas as HTMLCanvasElement;
    const compositeStart = performance.now();
    const frame = this.core.buildFrame(view, [2 / canvas.width, 2 / canvas.height]);
    this.syncCompositePages();
    for (const id of frame.removedCanvases) this.releaseCanvas(id);

    const encoder = device.createCommandEncoder();
    this.encodeLayerOps(encoder, frame.ops, frame.prediction);

    const timing = this.timestamps && !this.timestamps.busy && (frame.composites.length > 0 || frame.downsample.runs.length > 0)
      ? this.timestamps : null;
    const passes: GPURenderPassEncoder[] = [];
    const beginTimed = (descriptor: GPURenderPassDescriptor, index: number, total: number): GPURenderPassEncoder => {
      const writes = timing
        ? {
            timestampWrites: {
              querySet: timing.query,
              ...(index === 0 ? { beginningOfPassWriteIndex: 0 } : {}),
              ...(index === total - 1 ? { endOfPassWriteIndex: 1 } : {}),
            },
          }
        : {};
      const pass = encoder.beginRenderPass({ ...descriptor, ...(index === 0 || index === total - 1 ? writes : {}) });
      passes.push(pass);
      return pass;
    };
    const totalPasses =
      frame.composites.reduce((n, b) => n + b.runs.length, 0) + frame.downsample.runs.length;
    this.encodeComposites(frame, (d, i) => beginTimed(d, i, totalPasses));
    const compositeCpuMs = performance.now() - compositeStart;
    if (timing && totalPasses > 0) {
      encoder.resolveQuerySet(timing.query, 0, 2, timing.resolve, 0);
      encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
    }

    const screen = this.context.getCurrentTexture();
    this.encodeDisplay(encoder, screen, frame.display);
    const pendingReadbacks = frame.readbacks.map((r) => this.encodeReadback(encoder, r, screen));

    device.queue.submit([encoder.finish()]);
    const submittedAt = performance.now();
    for (const finish of pendingReadbacks) void finish();
    const compositeGpuMs = timing && totalPasses > 0 ? this.readTimestamps(timing) : undefined;
    const gpuDone = device.queue.onSubmittedWorkDone().then(() => performance.now());
    return {
      submittedAt,
      gpuDone,
      compositedTiles: frame.stats.composited,
      downsampledTiles: frame.stats.downsampled,
      visibleCanvases: frame.stats.visibleCanvases,
      compositeCpuMs,
      ...(compositeGpuMs ? { compositeGpuMs } : {}),
    };
  }

  destroy(): void {
    this.device.destroy();
  }

  // --- layer tile work ----------------------------------------------------------

  private encodeLayerOps(encoder: GPUCommandEncoder, ops: readonly FrameOp[], prediction: Dab[] | null): void {
    // Upload every dab used this frame (stroke ops, then the prediction) in one go.
    const dabBatches = ops.flatMap((op) => (op.kind === 'dabs' ? [op.dabs] : []));
    if (prediction) dabBatches.push(prediction);
    const totalDabs = dabBatches.reduce((n, b) => n + b.length, 0);
    this.dabStaging = ensureCapacity(this.dabStaging, totalDabs * DAB_FLOATS);
    let dabCursor = 0;
    for (const batch of dabBatches) {
      packDabs(batch, this.dabStaging, dabCursor);
      dabCursor += batch.length;
    }
    const dabBuffer = this.dabBuffer.upload(this.dabStaging, totalDabs * DAB_FLOATS);

    // Merge instances, ordered by merge op and then by destination page.
    const mergeGroups = ops.flatMap((op) => (op.kind === 'merge' ? [{ op, groups: [...groupByDstPage(op.jobs)] }] : []));
    const totalJobs = mergeGroups.reduce((n, m) => n + m.op.jobs.length, 0);
    this.mergeStaging = ensureCapacity(this.mergeStaging, totalJobs * MERGE_INSTANCE_FLOATS);
    let mergeCursor = 0;
    for (const { op, groups } of mergeGroups) {
      for (const [, jobs] of groups) for (const job of jobs) packMergeInstance(job, op.style, op.canvas, this.mergeStaging, mergeCursor++);
    }
    const mergeBuffer = this.mergeBuffer.upload(this.mergeStaging, totalJobs * MERGE_INSTANCE_FLOATS);

    let dabOffset = 0;
    let mergeOffset = 0;
    let mergeIndex = 0;
    for (const op of ops) {
      if (op.kind === 'clearMask') {
        this.clearPass(encoder, this.strokeMask);
      } else if (op.kind === 'dabs') {
        this.dabPass(encoder, this.strokeMask, dabBuffer, dabOffset, op.dabs.length);
        dabOffset += op.dabs.length;
      } else if (op.kind === 'merge') {
        const { groups } = mergeGroups[mergeIndex++]!;
        for (const job of op.jobs) {
          this.copyTile(encoder, job.src, 0, 0, job.dst, 0, 0, TILE_SIZE, TILE_SIZE);
        }
        for (const [page, jobs] of groups) {
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.layerPages.textures[page]!.createView(), loadOp: 'load', storeOp: 'store' }],
          });
          pass.setPipeline(this.mergePipeline);
          pass.setBindGroup(0, this.mergeBindGroup);
          pass.setVertexBuffer(0, mergeBuffer);
          pass.draw(4, jobs.length, 0, mergeOffset);
          pass.end();
          mergeOffset += jobs.length;
        }
      } else {
        for (const slot of op.zero) this.copyTile(encoder, null, 0, 0, slot, 0, 0, TILE_SIZE, TILE_SIZE);
        for (const c of op.copies) this.copyTile(encoder, c.src, c.sx, c.sy, c.dst, c.dx, c.dy, c.width, c.height);
      }
    }
    if (prediction) {
      this.clearPass(encoder, this.predictionMask);
      this.dabPass(encoder, this.predictionMask, dabBuffer, dabOffset, prediction.length);
    }
  }

  /**
   * Copy a region between layer tile slots (src null = transparent). WebGPU
   * can't copy within one texture, so same-page copies go through a scratch tile.
   */
  private copyTile(
    encoder: GPUCommandEncoder,
    src: TileSlot | null, sx: number, sy: number,
    dst: TileSlot, dx: number, dy: number,
    width: number, height: number,
  ): void {
    const size = { width, height };
    const d = slotLocation(dst);
    const dstCopy = { texture: this.layerPages.textures[d.page]!, origin: { x: d.x + dx, y: d.y + dy } };
    if (src === null) {
      encoder.copyTextureToTexture({ texture: this.zeroTile }, dstCopy, size);
      return;
    }
    const s = slotLocation(src);
    const srcCopy = { texture: this.layerPages.textures[s.page]!, origin: { x: s.x + sx, y: s.y + sy } };
    if (s.page === d.page) {
      encoder.copyTextureToTexture(srcCopy, { texture: this.scratchTile }, size);
      encoder.copyTextureToTexture({ texture: this.scratchTile }, dstCopy, size);
    } else {
      encoder.copyTextureToTexture(srcCopy, dstCopy, size);
    }
  }

  // --- composite pyramid ----------------------------------------------------------

  private encodeComposites(
    frame: Frame,
    begin: (descriptor: GPURenderPassDescriptor, index: number) => GPURenderPassEncoder,
  ): void {
    let passIndex = 0;
    // All composite instances in one buffer, batches one after another.
    const total = frame.composites.reduce((n, b) => n + b.instances.length, 0);
    const all = new Float32Array(total);
    let offset = 0;
    const firsts: number[] = [];
    for (const batch of frame.composites) {
      all.set(batch.instances, offset);
      firsts.push(offset / COMPOSITE_INSTANCE_FLOATS);
      offset += batch.instances.length;
    }
    const compositeBuffer = this.compositeBuffer.upload(all);

    frame.composites.forEach((batch, b) => {
      const gpu = this.canvasResources(batch.canvasId);
      if (batch.upload) {
        this.device.queue.writeBuffer(gpu.uniforms, 0, batch.upload.uniforms);
        this.device.queue.writeTexture({ texture: gpu.lookup }, batch.upload.lookup, { bytesPerRow: TILE_COUNT * 4 }, [TILE_COUNT, MAX_SOURCES]);
      }
      for (const run of batch.runs) {
        const pass = begin({ colorAttachments: [{ view: this.level0Pages.textures[run.page]!.createView(), loadOp: 'load', storeOp: 'store' }] }, passIndex++);
        pass.setPipeline(this.compositePipeline);
        pass.setBindGroup(0, gpu.bindGroup!);
        pass.setVertexBuffer(0, compositeBuffer);
        pass.draw(4, run.count, 0, firsts[b]! + run.first);
        pass.end();
      }
    });

    if (frame.downsample.runs.length > 0) {
      const buffer = this.downsampleBuffer.upload(frame.downsample.instances);
      for (const run of frame.downsample.runs) {
        const pass = begin({ colorAttachments: [{ view: this.previewPages.textures[run.page]!.createView(), loadOp: 'load', storeOp: 'store' }] }, passIndex++);
        pass.setPipeline(this.downsamplePipeline);
        pass.setBindGroup(0, this.downsampleBindGroup);
        pass.setVertexBuffer(0, buffer);
        pass.draw(4, run.count, 0, run.first);
        pass.end();
      }
    }
  }

  private encodeDisplay(encoder: GPUCommandEncoder, screen: GPUTexture, display: Frame['display']): void {
    const [r, g, b] = WORKSPACE_BACKGROUND;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: screen.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a: 1 } }],
    });
    const tileBuffer = this.tileQuadBuffer.upload(display.tiles);
    const solidBuffer = this.solidBuffer.upload(display.solids);
    for (const run of display.runs) {
      if (run.kind === 'solid') {
        pass.setPipeline(this.solidPipeline);
        pass.setVertexBuffer(0, solidBuffer);
      } else {
        pass.setPipeline(this.displayPipeline);
        pass.setBindGroup(0, this.displayBindGroup(run.pool, run.page));
        pass.setVertexBuffer(0, tileBuffer);
      }
      pass.draw(4, run.count, 0, run.first);
    }
    pass.end();
  }

  private displayBindGroup(pool: 'level0' | 'preview', page: number): GPUBindGroup {
    const key = `${pool}:${page}`;
    let group = this.displayBindGroups.get(key);
    if (!group) {
      const texture = (pool === 'level0' ? this.level0Pages : this.previewPages).textures[page]!;
      group = this.device.createBindGroup({
        layout: this.displayPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.linearSampler },
          { binding: 1, resource: texture.createView() },
        ],
      });
      this.displayBindGroups.set(key, group);
    }
    return group;
  }

  // --- readbacks ------------------------------------------------------------

  /** Encodes the GPU side of a readback; returns a function that maps the result after submit. */
  private encodeReadback(encoder: GPUCommandEncoder, readback: Readback, screen: GPUTexture): () => Promise<void> {
    const device = this.device;
    const readBuffer = (bytes: number): GPUBuffer =>
      device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const mapped = async (buffer: GPUBuffer, use: (bytes: Uint8Array) => void): Promise<void> => {
      try {
        await buffer.mapAsync(GPUMapMode.READ);
        use(new Uint8Array(buffer.getMappedRange().slice(0)));
      } finally {
        buffer.destroy();
      }
    };

    switch (readback.kind) {
      case 'screenPixel': {
        const buffer = readBuffer(256);
        const x = Math.min(screen.width - 1, Math.max(0, Math.floor(readback.x)));
        const y = Math.min(screen.height - 1, Math.max(0, Math.floor(readback.y)));
        encoder.copyTextureToBuffer({ texture: screen, origin: { x, y } }, { buffer, bytesPerRow: 256 }, [1, 1]);
        const bgra = this.canvasFormat === 'bgra8unorm';
        return () => mapped(buffer, (b) => readback.resolve(bgra ? [b[2]!, b[1]!, b[0]!, 255] : [b[0]!, b[1]!, b[2]!, 255]));
      }
      case 'thumbnail': {
        const bytesPerRow = THUMBNAIL_SIZE * 4; // 256: already aligned
        const buffer = readBuffer(bytesPerRow * THUMBNAIL_SIZE);
        const vertex = this.instanceBuffer(packThumbnailInstances(readback.tiles));
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: this.thumbTarget.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        if (readback.tiles.length > 0) {
          pass.setPipeline(this.thumbPipeline);
          pass.setBindGroup(0, this.thumbBindGroup);
          pass.setVertexBuffer(0, vertex);
          pass.draw(4, readback.tiles.length);
        }
        pass.end();
        encoder.copyTextureToBuffer({ texture: this.thumbTarget }, { buffer, bytesPerRow }, [THUMBNAIL_SIZE, THUMBNAIL_SIZE]);
        return () => mapped(buffer, (b) => {
          vertex.destroy();
          readback.resolve(b);
        });
      }
      case 'empty': {
        // One pass + copy per batch of tiles, all into separate read buffers.
        const bytesPerRow = EMPTY_TARGET_WIDTH * 4;
        const batches: { buffer: GPUBuffer; count: number }[] = [];
        const vertices: GPUBuffer[] = [];
        for (let start = 0; start < readback.slots.length; start += EMPTY_CHECK_BATCH) {
          const slots = readback.slots.slice(start, start + EMPTY_CHECK_BATCH);
          const vertex = this.instanceBuffer(new Float32Array(slots));
          vertices.push(vertex);
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.emptyTarget.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
          });
          pass.setPipeline(this.emptyPipeline);
          pass.setBindGroup(0, this.emptyBindGroup);
          pass.setVertexBuffer(0, vertex);
          pass.draw(4, slots.length);
          pass.end();
          const buffer = readBuffer(bytesPerRow * EMPTY_CHECK_BLOCK);
          encoder.copyTextureToBuffer({ texture: this.emptyTarget }, { buffer, bytesPerRow }, [EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK]);
          batches.push({ buffer, count: slots.length });
        }
        return async () => {
          const results: boolean[] = [];
          for (const { buffer, count } of batches) {
            await mapped(buffer, (b) => results.push(...emptyTilesFromReadback(b, EMPTY_TARGET_WIDTH, count)));
          }
          vertices.forEach((v) => v.destroy());
          readback.resolve(results);
        };
      }
    }
  }

  private async readTimestamps(t: NonNullable<WebGPURenderer['timestamps']>): Promise<number> {
    t.busy = true;
    try {
      await t.read.mapAsync(GPUMapMode.READ);
      const [begin, end] = new BigInt64Array(t.read.getMappedRange());
      t.read.unmap();
      return Number(end! - begin!) / 1e6;
    } finally {
      t.busy = false;
    }
  }

  // --- resources ------------------------------------------------------------

  private clearPass(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      })
      .end();
  }

  private dabPass(encoder: GPUCommandEncoder, target: GPUTexture, buffer: GPUBuffer, first: number, count: number): void {
    if (count === 0) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.dabPipeline);
    pass.setBindGroup(0, this.dabBindGroup);
    pass.setVertexBuffer(0, buffer);
    pass.draw(4, count, 0, first);
    pass.end();
  }

  private instanceBuffer(data: Float32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private ensureLayerPages(slots: readonly TileSlot[]): void {
    if (slots.length === 0) return;
    if (this.layerPages.ensure(Math.max(...slots.map((s) => slotLocation(s).page)) + 1)) this.rebuildLayerBindGroups();
  }

  private syncCompositePages(): void {
    const level0 = this.level0Pages.ensure(this.core.planner.level0Pool.pagesNeeded);
    const preview = this.previewPages.ensure(this.core.planner.previewPool.pagesNeeded);
    if (level0 || preview) this.rebuildCompositeBindGroups();
  }

  private canvasResources(id: CanvasId): CanvasGpu {
    let gpu = this.canvasGpu.get(id);
    if (!gpu) {
      gpu = {
        uniforms: this.device.createBuffer({
          size: packCompositeUniforms({ paper: [1, 1, 1], sources: [], liveStroke: null }).byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        lookup: this.device.createTexture({
          label: `lookup ${id}`, size: [TILE_COUNT, MAX_SOURCES], format: 'r32uint',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
        bindGroup: null,
      };
      this.canvasGpu.set(id, gpu);
    }
    gpu.bindGroup ??= this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.uniforms } },
        { binding: 1, resource: gpu.lookup.createView() },
        { binding: 2, resource: this.strokeMask.createView() },
        { binding: 3, resource: this.predictionMask.createView() },
        ...this.pageEntries(this.layerPages, MAX_ATLAS_PAGES, 4),
      ],
    });
    return gpu;
  }

  private releaseCanvas(id: CanvasId): void {
    const gpu = this.canvasGpu.get(id);
    if (!gpu) return;
    gpu.uniforms.destroy();
    gpu.lookup.destroy();
    this.canvasGpu.delete(id);
  }

  /** Bind group entries for every page of a pool (missing pages bound to a 1×1 dummy). */
  private pageEntries(pages: Pages, count: number, first: number): GPUBindGroupEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      binding: first + i,
      resource: (pages.textures[i] ?? this.dummyPage).createView(),
    }));
  }

  private rebuildLayerBindGroups(): void {
    for (const gpu of this.canvasGpu.values()) gpu.bindGroup = null;
    this.emptyBindGroup = this.device.createBindGroup({
      layout: this.emptyPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.emptyUniformBindings } }, ...this.pageEntries(this.layerPages, MAX_ATLAS_PAGES, 1)],
    });
    this.thumbBindGroup = this.device.createBindGroup({
      layout: this.thumbPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.thumbUniformBindings } }, ...this.pageEntries(this.layerPages, MAX_ATLAS_PAGES, 1)],
    });
  }

  private rebuildCompositeBindGroups(): void {
    this.displayBindGroups.clear();
    this.downsampleBindGroup = this.device.createBindGroup({
      layout: this.downsamplePipeline.getBindGroupLayout(0),
      entries: this.pageEntries(this.level0Pages, COMPOSITE_LEVEL0_PAGES, 0),
    });
  }
}
