import {
  ATLAS_PAGE_SIZE,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_ATLAS_PAGES,
  PAGE_BYTES,
  THUMBNAIL_SIZE,
  TILE_COUNT,
  TILE_SIZE,
} from '../../config';
import { slotLocation, type TileKey, type TileSlot } from '../../document/tiles';
import {
  EMPTY_CHECK_BATCH,
  EMPTY_CHECK_BLOCK,
  MAX_SOURCES,
  MERGE_INSTANCE_FLOATS,
  emptyTilesFromReadback,
  groupByDstPage,
  packCompositeUniforms,
  packLookup,
  packMergeInstance,
  packThumbnailInstances,
  packTileOrigins,
} from '../compositePacking';
import { DAB_FLOATS, DAB_HARDNESS, FrameQueue, ensureCapacity, packDabs, type Readback } from '../frameQueue';
import type {
  CompositeState,
  Dab,
  FrameInfo,
  MergeJob,
  Renderer,
  Rgba8,
  StrokeStyle,
} from '../renderer';
import { WORKSPACE_BACKGROUND } from '../workspace';
import { COMPOSITE_WGSL, DAB_WGSL, DISPLAY_WGSL, EMPTY_CHECK_WGSL, MERGE_WGSL, THUMBNAIL_WGSL } from './shaders';

const TILE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MASK_FORMAT: GPUTextureFormat = 'r8unorm';
const EMPTY_TARGET_WIDTH = EMPTY_CHECK_BATCH * EMPTY_CHECK_BLOCK;

/** Dynamic vertex buffer that grows to fit. */
class GrowableBuffer {
  buffer: GPUBuffer | null = null;
  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
  ) {}

  upload(data: Float32Array, floats: number): GPUBuffer {
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

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;

  private readonly queue = new FrameQueue();
  private lost = false;

  private readonly pages: GPUTexture[] = [];
  private readonly dummyPage: GPUTexture;
  private readonly composite: GPUTexture;
  private readonly strokeMask: GPUTexture;
  private readonly predictionMask: GPUTexture;
  private readonly lookup: GPUTexture;
  private readonly lookupData = new Uint32Array(TILE_COUNT * MAX_SOURCES);
  private readonly zeroTile: GPUTexture;
  private readonly scratchTile: GPUTexture;
  private readonly emptyTarget: GPUTexture;
  private readonly thumbTarget: GPUTexture;

  private readonly dabPipeline: GPURenderPipeline;
  private readonly mergePipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly displayPipeline: GPURenderPipeline;
  private readonly emptyPipeline: GPURenderPipeline;
  private readonly thumbPipeline: GPURenderPipeline;

  private readonly compositeUniforms: GPUBuffer;
  private readonly displayUniforms: GPUBuffer;
  private readonly dabBindGroup: GPUBindGroup;
  private readonly mergeBindGroup: GPUBindGroup;
  private readonly displayBindGroup: GPUBindGroup;
  private readonly emptyUniformBindings: GPUBuffer;
  private readonly thumbUniformBindings: GPUBuffer;
  private compositeBindGroup!: GPUBindGroup;
  private emptyBindGroup!: GPUBindGroup;
  private thumbBindGroup!: GPUBindGroup;

  private readonly dabBuffer: GrowableBuffer;
  private readonly mergeBuffer: GrowableBuffer;
  private readonly originBuffer: GrowableBuffer;
  private dabStaging = new Float32Array(4096);
  private mergeStaging = new Float32Array(1024);

  /** GPU timing of the composite pass, if the device supports timestamp queries. */
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
    context.configure({ device, format, alphaMode: 'opaque' });

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
    this.maxCanvasSize = device.limits.maxTextureDimension2D;
    void device.lost.then((info) => {
      this.lost = true;
      if (info.reason !== 'destroyed') this.onLost?.(`WebGPU device lost (${info.message}) — reload the page.`);
    });
    device.onuncapturederror = (e) => console.error('WebGPU error:', e.error.message);

    const T = GPUTextureUsage;
    const canvasSize = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    this.dummyPage = device.createTexture({ label: 'dummy page', size: [1, 1], format: TILE_FORMAT, usage: T.TEXTURE_BINDING });
    this.composite = device.createTexture({
      label: 'composite cache', size: canvasSize, format: TILE_FORMAT,
      usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
    });
    const maskUsage = T.RENDER_ATTACHMENT | T.TEXTURE_BINDING;
    this.strokeMask = device.createTexture({ label: 'stroke mask', size: canvasSize, format: MASK_FORMAT, usage: maskUsage });
    this.predictionMask = device.createTexture({ label: 'prediction mask', size: canvasSize, format: MASK_FORMAT, usage: maskUsage });
    this.lookup = device.createTexture({
      label: 'tile lookup', size: [TILE_COUNT, MAX_SOURCES], format: 'r32uint', usage: T.TEXTURE_BINDING | T.COPY_DST,
    });
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
    const strip: GPUPrimitiveState = { topology: 'triangle-strip' };
    const pipeline = (
      label: string,
      code: string,
      format: GPUTextureFormat,
      blend: GPUBlendState | undefined,
      buffers: GPUVertexBufferLayout[] = [],
    ): GPURenderPipeline => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers },
        fragment: { module, entryPoint: 'fs', targets: [{ format, ...(blend ? { blend } : {}) }] },
        primitive: strip,
      });
    };
    const instanced = (stride: number, attributes: GPUVertexAttribute[]): GPUVertexBufferLayout => ({
      arrayStride: stride, stepMode: 'instance', attributes,
    });

    this.dabPipeline = pipeline('dab', DAB_WGSL, MASK_FORMAT, { color: max, alpha: max }, [
      instanced(DAB_FLOATS * 4, [{ shaderLocation: 0, offset: 0, format: 'float32x4' }]),
    ]);
    this.mergePipeline = pipeline('merge', MERGE_WGSL, TILE_FORMAT, premultipliedOver, [
      instanced(MERGE_INSTANCE_FLOATS * 4, [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
        { shaderLocation: 2, offset: 32, format: 'float32x4' },
      ]),
    ]);
    this.compositePipeline = pipeline('composite', COMPOSITE_WGSL, TILE_FORMAT, replace, [
      instanced(8, [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]),
    ]);
    this.displayPipeline = pipeline('display', DISPLAY_WGSL, canvasFormat, undefined);
    this.emptyPipeline = pipeline('empty check', EMPTY_CHECK_WGSL, TILE_FORMAT, replace, [
      instanced(4, [{ shaderLocation: 0, offset: 0, format: 'float32' }]),
    ]);
    this.thumbPipeline = pipeline('thumbnail', THUMBNAIL_WGSL, TILE_FORMAT, replace, [
      instanced(16, [{ shaderLocation: 0, offset: 0, format: 'float32x4' }]),
    ]);

    const uniform = (size: number, data?: Float32Array): GPUBuffer => {
      const buffer = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      if (data) device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    };
    const dabUniforms = uniform(16, new Float32Array([CANVAS_WIDTH, CANVAS_HEIGHT, DAB_HARDNESS, 0]));
    this.compositeUniforms = uniform(packCompositeUniforms(this.queue.compositeState).byteLength);
    this.displayUniforms = uniform(64);
    this.emptyUniformBindings = uniform(16, new Float32Array([EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK, 0, 0]));
    this.thumbUniformBindings = uniform(16, new Float32Array([THUMBNAIL_SIZE, THUMBNAIL_SIZE, 0, 0]));

    this.dabBindGroup = device.createBindGroup({
      layout: this.dabPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: dabUniforms } }],
    });
    this.mergeBindGroup = device.createBindGroup({
      layout: this.mergePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.strokeMask.createView() }],
    });
    this.displayBindGroup = device.createBindGroup({
      layout: this.displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.displayUniforms } },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: this.composite.createView() },
      ],
    });
    this.rebuildPageBindGroups();

    this.dabBuffer = new GrowableBuffer(device, 'dab instances');
    this.mergeBuffer = new GrowableBuffer(device, 'merge instances');
    this.originBuffer = new GrowableBuffer(device, 'composite tile origins');

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

  get pageCount(): number {
    return this.pages.length;
  }

  gpuMemoryBytes(): number {
    const canvasPixels = CANVAS_WIDTH * CANVAS_HEIGHT;
    return this.pages.length * PAGE_BYTES + canvasPixels * 4 + canvasPixels * 2 + TILE_COUNT * MAX_SOURCES * 4;
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  }

  beginStroke(): void {
    this.queue.clearMask();
  }

  addStrokeDabs(dabs: readonly Dab[]): void {
    this.queue.addDabs(dabs);
  }

  setPredictedDabs(dabs: readonly Dab[]): void {
    this.queue.setPrediction(dabs);
  }

  mergeStroke(jobs: readonly MergeJob[], style: StrokeStyle): void {
    if (jobs.length === 0) return;
    const pagesNeeded = Math.max(...jobs.map((j) => slotLocation(j.dst).page)) + 1;
    this.ensurePages(pagesNeeded);
    this.queue.merge(jobs, style);
  }

  setCompositeState(state: CompositeState): void {
    this.queue.setState(state);
  }

  invalidateTiles(keys: readonly TileKey[] | 'all'): void {
    this.queue.invalidate(keys);
  }

  readPixel(x: number, y: number): Promise<Rgba8> {
    return new Promise((resolve) => this.queue.addReadback({ kind: 'pixel', x, y, resolve }));
  }

  findEmptyTiles(slots: readonly TileSlot[]): Promise<boolean[]> {
    return new Promise((resolve) => this.queue.addReadback({ kind: 'empty', slots: [...slots], resolve }));
  }

  readThumbnail(tiles: ReadonlyMap<TileKey, TileSlot>): Promise<Uint8Array> {
    return new Promise((resolve) => this.queue.addReadback({ kind: 'thumbnail', tiles: [...tiles], resolve }));
  }

  render(docToClip: Float32Array, texelsPerPixel: number): FrameInfo {
    if (this.lost) return { submittedAt: performance.now(), gpuDone: null, compositedTiles: 0, compositeCpuMs: 0 };
    const device = this.device;
    const frame = this.queue.drain();

    // Upload every dab used this frame (stroke ops, then the prediction) in one go.
    const dabBatches = frame.ops.flatMap((op) => (op.kind === 'dabs' ? [op.dabs] : []));
    if (frame.prediction) dabBatches.push(frame.prediction);
    const totalDabs = dabBatches.reduce((n, b) => n + b.length, 0);
    this.dabStaging = ensureCapacity(this.dabStaging, totalDabs * DAB_FLOATS);
    let dabCursor = 0;
    for (const batch of dabBatches) {
      packDabs(batch, this.dabStaging, dabCursor);
      dabCursor += batch.length;
    }
    const dabBuffer = this.dabBuffer.upload(this.dabStaging, totalDabs * DAB_FLOATS);

    // Merge instances, ordered by merge op and then by destination page.
    const mergeGroups = frame.ops.flatMap((op) =>
      op.kind === 'merge' ? [{ op, groups: [...groupByDstPage(op.jobs)] }] : [],
    );
    const totalJobs = mergeGroups.reduce((n, m) => n + m.op.jobs.length, 0);
    this.mergeStaging = ensureCapacity(this.mergeStaging, totalJobs * MERGE_INSTANCE_FLOATS);
    let mergeCursor = 0;
    for (const { op, groups } of mergeGroups) {
      for (const [, jobs] of groups) for (const job of jobs) packMergeInstance(job, op.style, this.mergeStaging, mergeCursor++);
    }
    const mergeBuffer = this.mergeBuffer.upload(this.mergeStaging, totalJobs * MERGE_INSTANCE_FLOATS);

    const encoder = device.createCommandEncoder();
    let dabOffset = 0;
    let mergeOffset = 0;
    let mergeIndex = 0;
    for (const op of frame.ops) {
      if (op.kind === 'clearMask') {
        this.clearPass(encoder, this.strokeMask);
      } else if (op.kind === 'dabs') {
        this.dabPass(encoder, this.strokeMask, dabBuffer, dabOffset, op.dabs.length);
        dabOffset += op.dabs.length;
      } else {
        const { groups } = mergeGroups[mergeIndex++]!;
        this.copySourceTiles(encoder, op.jobs);
        for (const [page, jobs] of groups) {
          this.mergePass(encoder, page, mergeBuffer, mergeOffset, jobs.length);
          mergeOffset += jobs.length;
        }
      }
    }
    if (frame.prediction) {
      this.clearPass(encoder, this.predictionMask);
      this.dabPass(encoder, this.predictionMask, dabBuffer, dabOffset, frame.prediction.length);
    }

    // Composite the dirty tiles.
    const compositeStart = performance.now();
    if (frame.state) {
      device.queue.writeBuffer(this.compositeUniforms, 0, packCompositeUniforms(frame.state));
      packLookup(frame.state, this.lookupData);
      device.queue.writeTexture(
        { texture: this.lookup },
        this.lookupData,
        { bytesPerRow: TILE_COUNT * 4 },
        [TILE_COUNT, MAX_SOURCES],
      );
    }
    const timing = this.timestamps && !this.timestamps.busy && frame.dirty.length > 0 ? this.timestamps : null;
    if (frame.dirty.length > 0) {
      const origins = packTileOrigins(frame.dirty);
      const originBuffer = this.originBuffer.upload(origins, origins.length);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: this.composite.createView(), loadOp: 'load', storeOp: 'store' }],
        ...(timing ? { timestampWrites: { querySet: timing.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, this.compositeBindGroup);
      pass.setVertexBuffer(0, originBuffer);
      pass.draw(4, frame.dirty.length);
      pass.end();
      if (timing) {
        encoder.resolveQuerySet(timing.query, 0, 2, timing.resolve, 0);
        encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
      }
    }
    const compositeCpuMs = performance.now() - compositeStart;

    this.displayPass(encoder, docToClip, texelsPerPixel);
    const pendingReadbacks = frame.readbacks.map((r) => this.encodeReadback(encoder, r));

    device.queue.submit([encoder.finish()]);
    const submittedAt = performance.now();
    for (const finish of pendingReadbacks) void finish();
    let compositeGpuMs: Promise<number> | undefined;
    if (timing) compositeGpuMs = this.readTimestamps(timing);
    const gpuDone = device.queue.onSubmittedWorkDone().then(() => performance.now());
    return {
      submittedAt,
      gpuDone,
      compositedTiles: frame.dirty.length,
      compositeCpuMs,
      ...(compositeGpuMs ? { compositeGpuMs } : {}),
    };
  }

  destroy(): void {
    this.device.destroy();
  }

  // --- passes -------------------------------------------------------------

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

  /**
   * Copy each job's source tile into its destination slot (or zero it), so
   * the merge pass can blend the stroke on top. WebGPU can't copy within one
   * texture, so same-page copies go through a scratch tile.
   */
  private copySourceTiles(encoder: GPUCommandEncoder, jobs: readonly MergeJob[]): void {
    const size = { width: TILE_SIZE, height: TILE_SIZE };
    for (const job of jobs) {
      const dst = slotLocation(job.dst);
      const dstCopy = { texture: this.pages[dst.page]!, origin: { x: dst.x, y: dst.y } };
      if (job.src === null) {
        encoder.copyTextureToTexture({ texture: this.zeroTile }, dstCopy, size);
        continue;
      }
      const src = slotLocation(job.src);
      const srcCopy = { texture: this.pages[src.page]!, origin: { x: src.x, y: src.y } };
      if (src.page === dst.page) {
        encoder.copyTextureToTexture(srcCopy, { texture: this.scratchTile }, size);
        encoder.copyTextureToTexture({ texture: this.scratchTile }, dstCopy, size);
      } else {
        encoder.copyTextureToTexture(srcCopy, dstCopy, size);
      }
    }
  }

  private mergePass(encoder: GPUCommandEncoder, page: number, buffer: GPUBuffer, first: number, count: number): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.pages[page]!.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.mergePipeline);
    pass.setBindGroup(0, this.mergeBindGroup);
    pass.setVertexBuffer(0, buffer);
    pass.draw(4, count, 0, first);
    pass.end();
  }

  private displayPass(encoder: GPUCommandEncoder, m: Float32Array, texelsPerPixel: number): void {
    // prettier-ignore
    this.device.queue.writeBuffer(this.displayUniforms, 0, new Float32Array([
      m[0]!, m[1]!, m[2]!, 0,
      m[3]!, m[4]!, m[5]!, 0,
      m[6]!, m[7]!, m[8]!, 0,
      CANVAS_WIDTH, CANVAS_HEIGHT, texelsPerPixel, 0,
    ]));
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

  // --- readbacks ------------------------------------------------------------

  /** Encodes the GPU side of a readback; returns a function that maps the result after submit. */
  private encodeReadback(encoder: GPUCommandEncoder, readback: Readback): () => Promise<void> {
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
      case 'pixel': {
        const buffer = readBuffer(256);
        const x = Math.min(CANVAS_WIDTH - 1, Math.max(0, Math.floor(readback.x)));
        const y = Math.min(CANVAS_HEIGHT - 1, Math.max(0, Math.floor(readback.y)));
        encoder.copyTextureToBuffer({ texture: this.composite, origin: { x, y } }, { buffer, bytesPerRow: 256 }, [1, 1]);
        return () => mapped(buffer, (b) => readback.resolve([b[0]!, b[1]!, b[2]!, b[3]!]));
      }
      case 'thumbnail': {
        const bytesPerRow = THUMBNAIL_SIZE * 4; // 256: already aligned
        const buffer = readBuffer(bytesPerRow * THUMBNAIL_SIZE);
        const instances = packThumbnailInstances(readback.tiles);
        const vertex = this.instanceBuffer(instances);
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

  private instanceBuffer(data: Float32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private ensurePages(count: number): void {
    if (count > MAX_ATLAS_PAGES) throw new Error(`Tile pool limit: ${count} > ${MAX_ATLAS_PAGES} pages`);
    if (count <= this.pages.length) return;
    while (this.pages.length < count) {
      this.pages.push(
        this.device.createTexture({
          label: `atlas page ${this.pages.length}`,
          size: [ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE],
          format: TILE_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        }),
      );
    }
    this.rebuildPageBindGroups();
  }

  /** Bind groups that include every page (unallocated pages are bound to a 1×1 dummy). */
  private rebuildPageBindGroups(): void {
    const pageEntries = (first: number): GPUBindGroupEntry[] =>
      Array.from({ length: MAX_ATLAS_PAGES }, (_, i) => ({
        binding: first + i,
        resource: (this.pages[i] ?? this.dummyPage).createView(),
      }));
    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.compositeUniforms } },
        { binding: 1, resource: this.lookup.createView() },
        { binding: 2, resource: this.strokeMask.createView() },
        { binding: 3, resource: this.predictionMask.createView() },
        ...pageEntries(4),
      ],
    });
    this.emptyBindGroup = this.device.createBindGroup({
      layout: this.emptyPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.emptyUniformBindings } }, ...pageEntries(1)],
    });
    this.thumbBindGroup = this.device.createBindGroup({
      layout: this.thumbPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.thumbUniformBindings } }, ...pageEntries(1)],
    });
  }
}
