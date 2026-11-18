import {
  ATLAS_PAGE_SIZE,
  COMPOSITE_LEVEL0_PAGES,
  MAX_ATLAS_PAGES,
  PAGE_BYTES,
  THUMBNAIL_SIZE,
  TILE_BYTES,
  TILE_COUNT,
  TILE_SIZE,
} from '../../config';
import type { CanvasId } from '../../document/paintDocument';
import type { Rect } from '../../workspace/coords';
import type { TileStore } from '../../document/tileStore';
import { slotLocation, type TileId, type TileKey, type TileSlot } from '../../document/tiles';
import {
  COMPOSITE_UNIFORM_VEC4S,
  EMPTY_CHECK_BATCH,
  EMPTY_CHECK_BLOCK,
  MAX_SOURCES,
  MERGE_INSTANCE_FLOATS,
  emptyTilesFromReadback,
  groupByDstPage,
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
import { RenderCore, type Frame } from '../renderCore';
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

/** Compositor inputs of one canvas. */
interface CanvasGl {
  uniforms: Float32Array;
  lookup: WebGLTexture;
}

const EMPTY_TARGET_WIDTH = EMPTY_CHECK_BATCH * EMPTY_CHECK_BLOCK;
const LOOKUP_BYTES = TILE_COUNT * MAX_SOURCES * 4;

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;
  onNeedsFrame: (() => void) | null = null;
  onCompositeChanged: ((canvasId: CanvasId, dirty: Rect) => void) | null = null;

  private readonly gl: WebGL2RenderingContext;
  private readonly core: RenderCore;
  private lost = false;

  private readonly layerPages: Target[] = [];
  private readonly level0Pages: Target[] = [];
  private readonly previewPages: Target[] = [];
  private readonly canvasGl = new Map<CanvasId, CanvasGl>();
  private readonly dummyPage: WebGLTexture;
  private readonly strokeMask: Target;
  private readonly predictionMask: Target;
  private readonly scratchTile: Target;
  private readonly emptyTarget: Target;
  private readonly thumbTarget: Target;

  private readonly dabProgram: Program;
  private readonly mergeProgram: Program;
  private readonly compositeProgram: Program;
  private readonly downsampleProgram: Program;
  private readonly displayProgram: Program;
  private readonly solidProgram: Program;
  private readonly emptyProgram: Program;
  private readonly thumbProgram: Program;

  private readonly instanceBuffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private staging = new Float32Array(4096);

  static create(canvas: HTMLCanvasElement, layerSlots: number): WebGL2Renderer {
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
    return new WebGL2Renderer(canvas, gl, layerSlots);
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, layerSlots: number) {
    this.gl = gl;
    this.core = RenderCore.withLayerBudget(layerSlots);
    this.core.residency.onReloaded = () => this.onNeedsFrame?.();
    this.core.onCompositeChanged = (canvasId, dirty) => this.onCompositeChanged?.(canvasId, dirty);
    this.maxCanvasSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.('WebGL context lost — reload the page.');
    });

    this.dummyPage = this.createTexture(1, 1, gl.RGBA8, false);
    this.strokeMask = this.createTarget(S.MASK_SIZE, S.MASK_SIZE, gl.R8);
    this.predictionMask = this.createTarget(S.MASK_SIZE, S.MASK_SIZE, gl.R8);
    this.scratchTile = this.createTarget(TILE_SIZE, TILE_SIZE, gl.RGBA8);
    this.emptyTarget = this.createTarget(EMPTY_TARGET_WIDTH, EMPTY_CHECK_BLOCK, gl.RGBA8);
    this.thumbTarget = this.createTarget(THUMBNAIL_SIZE, THUMBNAIL_SIZE, gl.RGBA8);

    this.dabProgram = this.createProgram(S.DAB_VS, S.DAB_FS);
    this.mergeProgram = this.createProgram(S.MERGE_VS, S.MERGE_FS);
    this.compositeProgram = this.createProgram(S.COMPOSITE_VS, S.COMPOSITE_FS);
    this.downsampleProgram = this.createProgram(S.DOWNSAMPLE_VS, S.DOWNSAMPLE_FS);
    this.displayProgram = this.createProgram(S.DISPLAY_VS, S.DISPLAY_FS);
    this.solidProgram = this.createProgram(S.SOLID_VS, S.SOLID_FS);
    this.emptyProgram = this.createProgram(S.EMPTY_CHECK_VS, S.EMPTY_CHECK_FS);
    this.thumbProgram = this.createProgram(S.THUMBNAIL_VS, S.THUMBNAIL_FS);

    // Quad corners come from gl_VertexID; all per-instance data goes through one buffer.
    this.vao = gl.createVertexArray()!;
    this.instanceBuffer = gl.createBuffer()!;
  }

  memory(): RendererMemory {
    const compositePages = this.level0Pages.length + this.previewPages.length;
    const masks = S.MASK_SIZE * S.MASK_SIZE * 2;
    return {
      layerPages: this.layerPages.length,
      compositePages,
      bytes: (this.layerPages.length + compositePages) * PAGE_BYTES + masks + this.canvasGl.size * LOOKUP_BYTES,
      ...this.core.tileMemory(),
    };
  }

  takeReloadTimes(): number[] {
    return this.core.residency.takeReloadTimes();
  }

  useTileStore(store: TileStore): void {
    this.core.useTileStore(store);
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
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
    this.core.merge(canvasId, jobs, style);
  }

  retile(canvasId: CanvasId, jobs: readonly RetileJob[]): void {
    this.core.retile(jobs);
    this.core.invalidate(canvasId, 'all');
  }

  readScreenPixel(x: number, y: number): Promise<Rgba8> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'screenPixel', x, y, resolve }));
  }

  findEmptyTiles(slots: readonly TileId[]): Promise<boolean[]> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'empty', slots: [...slots], resolve }));
  }

  readThumbnail(tiles: ReadonlyMap<TileKey, TileId>): Promise<Uint8Array> {
    return new Promise((resolve) => this.core.queue.addReadback({ kind: 'thumbnail', tiles: [...tiles], resolve }));
  }

  render(view: ViewState): FrameInfo {
    const gl = this.gl;
    const idle = { submittedAt: performance.now(), gpuDone: null, compositedTiles: 0, downsampledTiles: 0, visibleCanvases: 0, compositeCpuMs: 0, moreWork: false };
    if (this.lost) return idle;
    const compositeStart = performance.now();
    const frame = this.core.buildFrame(view, [2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight]);
    this.syncPages();
    for (const id of frame.removedCanvases) this.releaseCanvas(id);

    this.runLayerOps(frame.ops, frame.prediction);
    this.runComposites(frame);
    const compositeCpuMs = performance.now() - compositeStart;

    this.drawDisplay(frame.display);
    // Readbacks run after the display pass, so a screen pixel shows this frame.
    for (const r of frame.readbacks) this.runReadback(r);
    gl.flush();
    return {
      submittedAt: performance.now(),
      gpuDone: null,
      compositedTiles: frame.stats.composited,
      downsampledTiles: frame.stats.downsampled,
      visibleCanvases: frame.stats.visibleCanvases,
      moreWork: frame.moreWork,
      compositeCpuMs,
    };
  }

  destroy(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // --- layer tile work ----------------------------------------------------------

  private runLayerOps(ops: readonly FrameOp[], prediction: Dab[] | null): void {
    for (const op of ops) {
      if (op.kind === 'clearMask') this.clear(this.strokeMask, 0, 0, 0, 0);
      else if (op.kind === 'dabs') this.drawDabs(this.strokeMask, op.dabs);
      else if (op.kind === 'merge') this.merge(op);
      else if (op.kind === 'copies') {
        for (const slot of op.zero) this.clearSlot(slot);
        for (const c of op.copies) this.copyRegion(c.src, c.sx, c.sy, c.dst, c.dx, c.dy, c.width, c.height);
      } else if (op.kind === 'evict') op.done(this.readSlot(op.slot));
      else this.writeSlot(op.slot, op.rgba);
    }
    if (prediction) {
      this.clear(this.predictionMask, 0, 0, 0, 0);
      this.drawDabs(this.predictionMask, prediction);
    }
  }

  private drawDabs(target: Target, dabs: readonly Dab[]): void {
    if (dabs.length === 0) return;
    const gl = this.gl;
    this.staging = ensureCapacity(this.staging, dabs.length * DAB_FLOATS);
    packDabs(dabs, this.staging, 0);
    this.bindTarget(target, S.MASK_SIZE, S.MASK_SIZE);
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
  private merge(op: Extract<FrameOp, { kind: 'merge' }>): void {
    const gl = this.gl;
    for (const job of op.jobs) {
      if (job.src === null) this.clearSlot(job.dst);
      else this.copyRegion(job.src, 0, 0, job.dst, 0, 0, TILE_SIZE, TILE_SIZE);
    }

    gl.useProgram(this.mergeProgram.program);
    this.bindTexture(0, this.strokeMask.texture, this.mergeProgram, 'u_strokeMask');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const [page, pageJobs] of groupByDstPage(op.jobs)) {
      this.staging = ensureCapacity(this.staging, pageJobs.length * MERGE_INSTANCE_FLOATS);
      pageJobs.forEach((job, i) => packMergeInstance(job, op.style, op.canvas, this.staging, i));
      this.bindTarget(this.layerPages[page]!, ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE);
      this.setInstances(this.staging, pageJobs.length * MERGE_INSTANCE_FLOATS, [4, 4, 4]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pageJobs.length);
    }
    gl.disable(gl.BLEND);
  }

  /** Synchronous readback of one tile (WebGL2 has no simple async readback). */
  private readSlot(slot: TileSlot): Uint8Array {
    const gl = this.gl;
    const at = slotLocation(slot);
    const rgba = new Uint8Array(TILE_BYTES);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerPages[at.page]!.framebuffer);
    gl.readPixels(at.x, at.y, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return rgba;
  }

  private writeSlot(slot: TileSlot, rgba: Uint8Array): void {
    const gl = this.gl;
    const at = slotLocation(slot);
    gl.bindTexture(gl.TEXTURE_2D, this.layerPages[at.page]!.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  private clearSlot(slot: TileSlot): void {
    const gl = this.gl;
    const d = slotLocation(slot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerPages[d.page]!.framebuffer);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(d.x, d.y, TILE_SIZE, TILE_SIZE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Copy a region between layer slots; a framebuffer can't be blitted onto itself, so same-page copies use a scratch tile. */
  private copyRegion(src: TileSlot, sx: number, sy: number, dst: TileSlot, dx: number, dy: number, width: number, height: number): void {
    const s = slotLocation(src);
    const d = slotLocation(dst);
    const srcFb = this.layerPages[s.page]!.framebuffer;
    const dstFb = this.layerPages[d.page]!.framebuffer;
    if (s.page === d.page) {
      this.blit(srcFb, s.x + sx, s.y + sy, this.scratchTile.framebuffer, 0, 0, width, height);
      this.blit(this.scratchTile.framebuffer, 0, 0, dstFb, d.x + dx, d.y + dy, width, height);
    } else {
      this.blit(srcFb, s.x + sx, s.y + sy, dstFb, d.x + dx, d.y + dy, width, height);
    }
  }

  // --- composite pyramid ----------------------------------------------------------

  private runComposites(frame: Frame): void {
    const gl = this.gl;
    const p = this.compositeProgram;
    for (const batch of frame.composites) {
      const canvas = this.canvasResources(batch.canvasId);
      if (batch.upload) {
        canvas.uniforms = batch.upload.uniforms;
        gl.bindTexture(gl.TEXTURE_2D, canvas.lookup);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_COUNT, MAX_SOURCES, gl.RED_INTEGER, gl.UNSIGNED_INT, batch.upload.lookup);
      }
      gl.useProgram(p.program);
      gl.uniform4fv(p.uniform('u_v'), canvas.uniforms, 0, COMPOSITE_UNIFORM_VEC4S * 4);
      this.bindTexture(0, canvas.lookup, p, 'u_lookup');
      this.bindTexture(1, this.strokeMask.texture, p, 'u_strokeMask');
      this.bindTexture(2, this.predictionMask.texture, p, 'u_predictionMask');
      this.bindPages(3, p, S.PAGE_UNIFORMS, this.layerPages);
      for (const run of batch.runs) {
        this.bindTarget(this.level0Pages[run.page]!, ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE);
        this.setInstances(batch.instances.subarray(run.first * 4, (run.first + run.count) * 4), run.count * 4, [4]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
      }
    }

    const down = frame.downsample;
    if (down.runs.length === 0) return;
    const dp = this.downsampleProgram;
    gl.useProgram(dp.program);
    this.bindPages(0, dp, S.LEVEL0_UNIFORMS, this.level0Pages);
    for (const run of down.runs) {
      this.bindTarget(this.previewPages[run.page]!, ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE);
      this.setInstances(down.instances.subarray(run.first * 12, (run.first + run.count) * 12), run.count * 12, [4, 4, 4]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
    }
  }

  private drawDisplay(display: Frame['display']): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(...WORKSPACE_BACKGROUND, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const run of display.runs) {
      if (run.kind === 'solid') {
        gl.useProgram(this.solidProgram.program);
        this.setInstances(display.solids.subarray(run.first * 12, (run.first + run.count) * 12), run.count * 12, [4, 4, 4]);
      } else {
        const p = this.displayProgram;
        gl.useProgram(p.program);
        const page = (run.pool === 'level0' ? this.level0Pages : this.previewPages)[run.page]!;
        this.bindTexture(0, page.texture, p, 'u_tiles');
        this.setInstances(display.tiles.subarray(run.first * 16, (run.first + run.count) * 16), run.count * 16, [4, 4, 4, 4]);
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
    }
    gl.disable(gl.BLEND);
  }

  // --- readbacks (synchronous readPixels on small targets) -----------------------

  private runReadback(r: Readback): void {
    const gl = this.gl;
    switch (r.kind) {
      case 'screenPixel': {
        const out = new Uint8Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const x = Math.min(gl.drawingBufferWidth - 1, Math.max(0, Math.floor(r.x)));
        const y = Math.min(gl.drawingBufferHeight - 1, Math.max(0, Math.floor(r.y)));
        gl.readPixels(x, gl.drawingBufferHeight - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out); // GL rows go bottom-up
        r.resolve([out[0]!, out[1]!, out[2]!, 255]);
        return;
      }
      case 'thumbnail': {
        const p = this.thumbProgram;
        this.clear(this.thumbTarget, 0, 0, 0, 0);
        if (r.tiles.length > 0) {
          this.bindTarget(this.thumbTarget, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
          gl.useProgram(p.program);
          gl.uniform2f(p.uniform('u_targetSize'), THUMBNAIL_SIZE, THUMBNAIL_SIZE);
          this.bindPages(0, p, S.PAGE_UNIFORMS, this.layerPages);
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
          this.bindPages(0, p, S.PAGE_UNIFORMS, this.layerPages);
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

  /** Create the atlas pages the slot pools now need. Composite pages are sampled with bilinear filtering. */
  private syncPages(): void {
    const layers = this.core.residency.slots.pagesNeeded;
    if (layers > MAX_ATLAS_PAGES) throw new Error(`Tile pool limit: ${layers} > ${MAX_ATLAS_PAGES} pages`);
    while (this.layerPages.length < layers) this.layerPages.push(this.createTarget(ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE, this.gl.RGBA8));
    const { level0Pool, previewPool } = this.core.planner;
    const level0 = Math.min(level0Pool.pagesNeeded, COMPOSITE_LEVEL0_PAGES);
    while (this.level0Pages.length < level0) this.level0Pages.push(this.createTarget(ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE, this.gl.RGBA8, true));
    while (this.previewPages.length < previewPool.pagesNeeded) {
      this.previewPages.push(this.createTarget(ATLAS_PAGE_SIZE, ATLAS_PAGE_SIZE, this.gl.RGBA8, true));
    }
  }

  private canvasResources(id: CanvasId): CanvasGl {
    let c = this.canvasGl.get(id);
    if (!c) {
      c = { uniforms: new Float32Array(COMPOSITE_UNIFORM_VEC4S * 4), lookup: this.createTexture(TILE_COUNT, MAX_SOURCES, this.gl.R32UI, false) };
      this.canvasGl.set(id, c);
    }
    return c;
  }

  private releaseCanvas(id: CanvasId): void {
    const c = this.canvasGl.get(id);
    if (!c) return;
    this.gl.deleteTexture(c.lookup);
    this.canvasGl.delete(id);
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

  /** Bind a set of page textures (missing ones to a 1×1 dummy) starting at texture unit `firstUnit`. */
  private bindPages(firstUnit: number, program: Program, names: readonly string[], pages: readonly Target[]): void {
    names.forEach((name, i) => this.bindTexture(firstUnit + i, pages[i]?.texture ?? this.dummyPage, program, name));
  }

  private blit(src: WebGLFramebuffer, sx: number, sy: number, dst: WebGLFramebuffer, dx: number, dy: number, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(sx, sy, sx + w, sy + h, dx, dy, dx + w, dy + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
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
   * Immutable-storage texture. `linear` filtering is only used for composite
   * pages (sampled by the display pass); everything else is read with
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
