import { CommandQueue, DAB_FLOATS, DAB_HARDNESS, packDabs } from '../commandQueue';
import {
  DOCUMENT_SIZE,
  WORKSPACE_BACKGROUND,
  type Dab,
  type FrameInfo,
  type Renderer,
  type StrokeStyle,
} from '../renderer';
import { DAB_FS, DAB_VS, DISPLAY_FS, DISPLAY_VS, FULLSCREEN_VS, MERGE_FS } from './shaders';

interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  readonly documentWidth = DOCUMENT_SIZE;
  readonly documentHeight = DOCUMENT_SIZE;
  readonly maxCanvasSize: number;
  onLost: ((message: string) => void) | null = null;

  private readonly gl: WebGL2RenderingContext;
  private readonly queue = new CommandQueue();
  private readonly documentTarget: RenderTarget;
  private readonly strokeTarget: RenderTarget;
  private readonly predictionTarget: RenderTarget;
  private readonly dabProgram: Program;
  private readonly mergeProgram: Program;
  private readonly displayProgram: Program;
  private readonly dabVao: WebGLVertexArrayObject;
  private readonly displayVao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly dabBuffer: WebGLBuffer;
  private dabStaging = new Float32Array(DAB_FLOATS * 4096);
  private dabBufferCapacity = 0; // in dabs
  private lost = false;

  static create(canvas: HTMLCanvasElement): WebGL2Renderer {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      // Low-latency hint; ignored by browsers that don't support it (e.g. Safari).
      desynchronized: true,
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

    this.documentTarget = this.createTarget(gl.RGBA8, gl.RGBA);
    this.strokeTarget = this.createTarget(gl.R8, gl.RED);
    this.predictionTarget = this.createTarget(gl.R8, gl.RED);

    this.dabProgram = this.createProgram(DAB_VS, DAB_FS, ['u_docSize', 'u_hardness']);
    this.mergeProgram = this.createProgram(FULLSCREEN_VS, MERGE_FS, ['u_mask', 'u_color', 'u_opacity']);
    this.displayProgram = this.createProgram(DISPLAY_VS, DISPLAY_FS, [
      'u_docToClip', 'u_docSize', 'u_document', 'u_stroke', 'u_prediction', 'u_strokeColor', 'u_strokeOpacity',
    ]);

    // Dab quads: a static corner buffer plus a per-instance dab buffer.
    this.dabVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dabVao);
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.dabBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);

    this.displayVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.displayVao);
    const unitQuad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(null);

    this.clearTarget(this.documentTarget, 1, 1, 1, 1);
    this.clearTarget(this.strokeTarget, 0, 0, 0, 0);
    this.clearTarget(this.predictionTarget, 0, 0, 0, 0);
  }

  resize(pixelWidth: number, pixelHeight: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
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
    const gl = this.gl;
    if (this.lost) return { submittedAt: performance.now(), gpuDone: null };

    const commands = this.queue.drain();
    const prediction = this.queue.predictionChanged ? this.queue.predictedDabs : null;
    this.queue.predictionChanged = false;

    // Upload every dab needed this frame in one go, remembering each batch's offset.
    const batches = commands.flatMap((c) => (c.kind === 'dabs' ? [c.dabs] : []));
    if (prediction) batches.push(prediction);
    this.uploadDabs(batches);

    let dabOffset = 0;
    for (const command of commands) {
      switch (command.kind) {
        case 'clearStroke':
          this.clearTarget(this.strokeTarget, 0, 0, 0, 0);
          break;
        case 'dabs':
          this.drawDabs(this.strokeTarget, dabOffset, command.dabs.length);
          dabOffset += command.dabs.length;
          break;
        case 'mergeStroke':
          this.mergeStroke(command.style);
          break;
        case 'clearDocument':
          this.clearTarget(this.documentTarget, 1, 1, 1, 1);
          break;
      }
    }
    if (prediction) {
      this.clearTarget(this.predictionTarget, 0, 0, 0, 0);
      this.drawDabs(this.predictionTarget, dabOffset, prediction.length);
    }

    this.drawDisplay(docToClip);
    gl.flush();
    return { submittedAt: performance.now(), gpuDone: null };
  }

  destroy(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // --- passes -------------------------------------------------------------

  private drawDabs(target: RenderTarget, firstDab: number, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, this.documentWidth, this.documentHeight);
    gl.useProgram(this.dabProgram.program);
    gl.uniform2f(this.dabProgram.uniforms.u_docSize!, this.documentWidth, this.documentHeight);
    gl.uniform1f(this.dabProgram.uniforms.u_hardness!, DAB_HARDNESS);
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuffer);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, firstDab * DAB_FLOATS * 4);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX); // overlapping dabs keep the highest coverage, no build-up
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
  }

  private mergeStroke(style: StrokeStyle): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.documentTarget.framebuffer);
    gl.viewport(0, 0, this.documentWidth, this.documentHeight);
    gl.useProgram(this.mergeProgram.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.strokeTarget.texture);
    gl.uniform1i(this.mergeProgram.uniforms.u_mask!, 0);
    gl.uniform3fv(this.mergeProgram.uniforms.u_color!, style.color);
    gl.uniform1f(this.mergeProgram.uniforms.u_opacity!, style.opacity);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  private drawDisplay(docToClip: Float32Array): void {
    const gl = this.gl;
    const style = this.queue.activeStyle;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(...WORKSPACE_BACKGROUND, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const p = this.displayProgram;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.uniforms.u_docToClip!, false, docToClip);
    gl.uniform2f(p.uniforms.u_docSize!, this.documentWidth, this.documentHeight);
    const textures = [this.documentTarget, this.strokeTarget, this.predictionTarget];
    const names = ['u_document', 'u_stroke', 'u_prediction'];
    textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.uniform1i(p.uniforms[names[i]!]!, i);
    });
    gl.uniform3fv(p.uniforms.u_strokeColor!, style?.color ?? [0, 0, 0]);
    gl.uniform1f(p.uniforms.u_strokeOpacity!, style?.opacity ?? 0);
    gl.bindVertexArray(this.displayVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // --- resources ----------------------------------------------------------

  private uploadDabs(batches: readonly (readonly Dab[])[]): void {
    const total = batches.reduce((n, b) => n + b.length, 0);
    if (total === 0) return;
    if (this.dabStaging.length < total * DAB_FLOATS) {
      this.dabStaging = new Float32Array(nextPowerOfTwo(total) * DAB_FLOATS);
    }
    let offset = 0;
    for (const batch of batches) {
      packDabs(batch, this.dabStaging, offset);
      offset += batch.length;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuffer);
    if (this.dabBufferCapacity < total) {
      this.dabBufferCapacity = this.dabStaging.length / DAB_FLOATS;
      gl.bufferData(gl.ARRAY_BUFFER, this.dabStaging.byteLength, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dabStaging, 0, total * DAB_FLOATS);
  }

  private createTarget(internalFormat: number, format: number): RenderTarget {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.documentWidth, this.documentHeight, 0, format, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer };
  }

  private clearTarget(target: RenderTarget, r: number, g: number, b: number, a: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, this.documentWidth, this.documentHeight);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private createProgram(vsSource: string, fsSource: string, uniformNames: string[]): Program {
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
    const uniforms: Program['uniforms'] = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }
}

function nextPowerOfTwo(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}
