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
  COMPOSITE_UNIFORM_VEC4S,
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
import type { CompositeState, Dab, FrameInfo, MergeJob, Renderer, Rgba8, StrokeStyle } from '../renderer';
import { WORKSPACE_BACKGROUND } from '../workspace';
import * as S from './shaders';

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface Program {
  program: WebGLProgram;
  uniform(name: string): WebGLUniformLocation | null;
}

const EMPTY_TARGET_WIDTH = EMPTY_CHECK_BATCH * EMPTY_CHECK_BLOCK;

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;

  private readonly gl: WebGL2RenderingContext;
  private readonly queue = new FrameQueue();
  private lost = false;

  private readonly pages: Target[] = [];
  private readonly dummyPage: WebGLTexture;
  private readonly composite: Target;
  private readonly strokeMask: Target;
  private readonly predictionMask: Target;
  private readonly scratchTile: Target;
  private readonly emptyTarget: Target;
  private readonly thumbTarget: Target;
  private readonly lookup: WebGLTexture;
  private readonly lookupData = new Uint32Array(TILE_COUNT * MAX_SOURCES);
  private compositeUniforms: Float32Array;

  private readonly dabProgram: Program;
  private readonly mergeProgram: Program;
  private readonly compositeProgram: Program;
  private readonly displayProgram: Program;
  private readonly emptyProgram: Program;
  private readonly thumbProgram: Program;

  private readonly instanceBuffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private staging = new Float32Array(4096);

  static create(canvas: HTMLCanvasElement): WebGL2Renderer {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true, // low-latency hint; ignored where unsupported (e.g. Safari)
    });
    if (!gl) throw new Error('WebGL2 is not available');
    return new WebGL2Renderer(canvas, gl);
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.maxCanvasSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.('WebGL context lost — reload the page.');
    });

    this.dummyPage = this.createTexture(1, 1, gl.RGBA8, false);
    this.composite = this.createTarget(CANVAS_WIDTH, CANVAS_HEIGHT, gl.RGBA8, true);
    this.strokeMask = this.createTarget(CANVAS_WIDTH, CANVAS_HEIGHT, gl.R8);
    this.predictionMask = this.createTarget(CANVAS_WIDTH, CANVAS_HEIGHT, gl.R8);
    this.scratchTile = this.createTarget(TILE_SIZE, TILE_SIZE, gl.RGBA8);
    this.emptyTarget = this.createTarget(EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK, gl.RGBA8);
    this.thumbTarget = this.createTarget(THUMBNAIL_SIZE, THUMBNAIL_SIZE, gl.RGBA8);
    this.lookup = this.createTexture(TILE_COUNT, MAX_SOURCES, gl.R32UI, false);
    this.compositeUniforms = packCompositeUniforms(this.queue.compositeState);

    this.dabProgram = this.createProgram(S.DAB_VS, S.DAB_FS);
    this.mergeProgram = this.createProgram(S.MERGE_VS, S.MERGE_FS);
    this.compositeProgram = this.createProgram(S.COMPOSITE_VS, S.COMPOSITE_FS);
    this.displayProgram = this.createProgram(S.DISPLAY_VS, S.DISPLAY_FS);
    this.emptyProgram = this.createProgram(S.EMPTY_CHECK_VS, S.EMPTY_CHECK_FS);
    this.thumbProgram = this.createProgram(S.THUMBNAIL_VS, S.THUMBNAIL_FS);

    // Quad corners come from gl_VertexID; all per-instance data goes through one buffer.
    this.vao = gl.createVertexArray()!;
    this.instanceBuffer = gl.createBuffer()!;

    for (const t of [this.composite, this.strokeMask, this.predictionMask]) this.clear(t, 0, 0, 0, 0);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  gpuMemoryBytes(): number {
    const canvasPixels = CANVAS_WIDTH * CANVAS_HEIGHT;
    return this.pages.length * PAGE_BYTES + canvasPixels * 4 + canvasPixels * 2 + TILE_COUNT * MAX_SOURCES * 4;
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
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
    this.ensurePages(Math.max(...jobs.map((j) => slotLocation(j.dst).page)) + 1);
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
    const gl = this.gl;
    if (this.lost) return { submittedAt: performance.now(), gpuDone: null, compositedTiles: 0, compositeCpuMs: 0 };
    const frame = this.queue.drain();

    for (const op of frame.ops) {
      if (op.kind === 'clearMask') this.clear(this.strokeMask, 0, 0, 0, 0);
      else if (op.kind === 'dabs') this.drawDabs(this.strokeMask, op.dabs);
      else this.merge(op.jobs, op.style);
    }
    if (frame.prediction) {
      this.clear(this.predictionMask, 0, 0, 0, 0);
      this.drawDabs(this.predictionMask, frame.prediction);
    }

    const compositeStart = performance.now();
    if (frame.state) {
      this.compositeUniforms = packCompositeUniforms(frame.state);
      packLookup(frame.state, this.lookupData);
      gl.bindTexture(gl.TEXTURE_2D, this.lookup);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_COUNT, MAX_SOURCES, gl.RED_INTEGER, gl.UNSIGNED_INT, this.lookupData);
    }
    if (frame.dirty.length > 0) this.compositeTiles(frame.dirty);
    const compositeCpuMs = performance.now() - compositeStart;

    this.drawDisplay(docToClip, texelsPerPixel);
    for (const r of frame.readbacks) this.runReadback(r);
    gl.flush();
    return { submittedAt: performance.now(), gpuDone: null, compositedTiles: frame.dirty.length, compositeCpuMs };
  }

  destroy(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // --- passes -------------------------------------------------------------

  private drawDabs(target: Target, dabs: readonly Dab[]): void {
    if (dabs.length === 0) return;
    const gl = this.gl;
    this.staging = ensureCapacity(this.staging, dabs.length * DAB_FLOATS);
    packDabs(dabs, this.staging, 0);
    this.bindTarget(target, CANVAS_WIDTH, CANVAS_HEIGHT);
    gl.useProgram(this.dabProgram.program);
    gl.uniform1f(this.dabProgram.uniform('u_hardness'), DAB_HARDNESS);
    this.setInstances(this.staging, dabs.length * DAB_FLOATS, [4]);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX); // overlapping dabs keep the highest coverage, no build-up
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dabs.length);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
  }

  /**
   * Write `src + stroke mask` into each job's dst slot: copy (or clear) the
   * source tile into place, then blend the mask on top with premultiplied
   * source-over, which is exactly paint (colour·m) or erase (0, alpha m).
   */
  private merge(jobs: readonly MergeJob[], style: StrokeStyle): void {
    const gl = this.gl;
    for (const job of jobs) {
      const dst = slotLocation(job.dst);
      const dstFb = this.pages[dst.page]!.framebuffer;
      if (job.src === null) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(dst.x, dst.y, TILE_SIZE, TILE_SIZE);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        continue;
      }
      const src = slotLocation(job.src);
      const srcFb = this.pages[src.page]!.framebuffer;
      if (src.page === dst.page) {
        // A framebuffer can't be blitted onto itself: go through the scratch tile.
        this.blit(srcFb, src.x, src.y, this.scratchTile.framebuffer, 0, 0);
        this.blit(this.scratchTile.framebuffer, 0, 0, dstFb, dst.x, dst.y);
      } else {
        this.blit(srcFb, src.x, src.y, dstFb, dst.x, dst.y);
      }
    }

    gl.useProgram(this.mergeProgram.program);
    this.bindTexture(0, this.strokeMask.texture, this.mergeProgram, 'u_strokeMask');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const [page, pageJobs] of groupByDstPage(jobs)) {
      this.staging = ensureCapacity(this.staging, pageJobs.length * MERGE_INSTANCE_FLOATS);
      pageJobs.forEach((job, i) => packMergeInstance(job, style, this.staging, i));
      this.bindTarget(this.pages[page]!, ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE);
      this.setInstances(this.staging, pageJobs.length * MERGE_INSTANCE_FLOATS, [4, 4, 4]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pageJobs.length);
    }
    gl.disable(gl.BLEND);
  }

  private compositeTiles(dirty: readonly TileKey[]): void {
    const gl = this.gl;
    const p = this.compositeProgram;
    this.bindTarget(this.composite, CANVAS_WIDTH, CANVAS_HEIGHT);
    gl.useProgram(p.program);
    gl.uniform4fv(p.uniform('u_v'), this.compositeUniforms, 0, COMPOSITE_UNIFORM_VEC4S * 4);
    this.bindTexture(0, this.lookup, p, 'u_lookup');
    this.bindTexture(1, this.strokeMask.texture, p, 'u_strokeMask');
    this.bindTexture(2, this.predictionMask.texture, p, 'u_predictionMask');
    this.bindPages(3, p);
    const origins = packTileOrigins(dirty);
    this.setInstances(origins, origins.length, [2]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dirty.length);
  }

  private drawDisplay(docToClip: Float32Array, texelsPerPixel: number): void {
    const gl = this.gl;
    const p = this.displayProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(...WORKSPACE_BACKGROUND, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.uniform('u_docToClip'), false, docToClip);
    gl.uniform4f(p.uniform('u_params'), CANVAS_WIDTH, CANVAS_HEIGHT, texelsPerPixel, 0);
    this.bindTexture(0, this.composite.texture, p, 'u_composite');
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // --- readbacks (synchronous readPixels on small targets) -----------------------

  private runReadback(r: Readback): void {
    const gl = this.gl;
    switch (r.kind) {
      case 'pixel': {
        const out = new Uint8Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.composite.framebuffer);
        const x = Math.min(CANVAS_WIDTH - 1, Math.max(0, Math.floor(r.x)));
        const y = Math.min(CANVAS_HEIGHT - 1, Math.max(0, Math.floor(r.y)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        r.resolve([out[0]!, out[1]!, out[2]!, out[3]!]);
        return;
      }
      case 'thumbnail': {
        const p = this.thumbProgram;
        this.clear(this.thumbTarget, 0, 0, 0, 0);
        if (r.tiles.length > 0) {
          this.bindTarget(this.thumbTarget, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
          gl.useProgram(p.program);
          gl.uniform2f(p.uniform('u_targetSize'), THUMBNAIL_SIZE, THUMBNAIL_SIZE);
          this.bindPages(0, p);
          const instances = packThumbnailInstances(r.tiles);
          this.setInstances(instances, instances.length, [4]);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.tiles.length);
        }
        const out = new Uint8Array(THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumbTarget.framebuffer);
        gl.readPixels(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
        r.resolve(out);
        return;
      }
      case 'empty': {
        const p = this.emptyProgram;
        const results: boolean[] = [];
        const out = new Uint8Array(EMPTY_TARGET_WIDTH * EMPTY_CHECK_BLOCK * 4);
        for (let start = 0; start < r.slots.length; start += EMPTY_CHECK_BATCH) {
          const slots = r.slots.slice(start, start + EMPTY_CHECK_BATCH);
          this.clear(this.emptyTarget, 0, 0, 0, 0);
          this.bindTarget(this.emptyTarget, EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK);
          gl.useProgram(p.program);
          gl.uniform2f(p.uniform('u_targetSize'), EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK);
          this.bindPages(0, p);
          const instances = new Float32Array(slots);
          this.setInstances(instances, instances.length, [1]);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, slots.length);
          gl.readPixels(0, 0, EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK, gl.RGBA, gl.UNSIGNED_BYTE, out);
          results.push(...emptyTilesFromReadback(out, EMPTY_TARGET_WIDTH, slots.length));
        }
        r.resolve(results);
        return;
      }
    }
  }

  // --- resources and state helpers ---------------------------------------------

  private ensurePages(count: number): void {
    if (count > MAX_ATLAS_PAGES) throw new Error(`Tile pool limit: ${count} > ${MAX_ATLAS_PAGES} pages`);
    while (this.pages.length < count) {
      this.pages.push(this.createTarget(ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE, this.gl.RGBA8));
    }
  }

  /** Point the vertex array at `floats` of `data`, split into instanced attributes of the given sizes. */
  private setInstances(data: Float32Array, floats: number, attributeSizes: number[]): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.STREAM_DRAW);
    const stride = attributeSizes.reduce((a, b) => a + b, 0) * 4;
    let offset = 0;
    for (let i = 0; i < 4; i++) {
      const size = attributeSizes[i];
      if (size === undefined) {
        gl.disableVertexAttribArray(i);
        continue;
      }
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(i, 1);
      offset += size * 4;
    }
  }

  private bindTarget(target: Target, width: number, height: number): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.viewport(0, 0, width, height);
  }

  private bindTexture(unit: number, texture: WebGLTexture, program: Program, name: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(program.uniform(name), unit);
  }

  /** Bind every atlas page (unallocated ones to a 1×1 dummy) starting at texture unit `firstUnit`. */
  private bindPages(firstUnit: number, program: Program): void {
    S.PAGE_UNIFORMS.forEach((name, i) => {
      this.bindTexture(firstUnit + i, this.pages[i]?.texture ?? this.dummyPage, program, name);
    });
  }

  private blit(src: WebGLFramebuffer, sx: number, sy: number, dst: WebGLFramebuffer, dx: number, dy: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(sx, sy, sx + TILE_SIZE, sy + TILE_SIZE, dx, dy, dx + TILE_SIZE, dy + TILE_SIZE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  private clear(target: Target, r: number, g: number, b: number, a: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Immutable-storage texture. `linear` filtering is only used for the
   * composite (sampled by the display pass); everything else is read with
   * texelFetch, and integer textures must be NEAREST anyway.
   */
  private createTexture(width: number, height: number, internalFormat: number, linear: boolean): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private createTarget(width: number, height: number, internalFormat: number, linear = false): Target {
    const gl = this.gl;
    const texture = this.createTexture(width, height, internalFormat, linear);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    // New WebGL textures are zero-initialised, which is "transparent" for tiles and masks.
    return { texture, framebuffer };
  }

  private createProgram(vsSource: string, fsSource: string): Program {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    const cache = new Map<string, WebGLUniformLocation | null>();
    return {
      program,
      uniform(name) {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
        return cache.get(name)!;
      },
    };
  }
}
