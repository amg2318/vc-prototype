/**
 * Asynchronous `readPixels` for WebGL2, so reading tiles back for saving and
 * eviction never stalls a frame.
 *
 * Plain `readPixels` into an array waits for the GPU to finish everything
 * before it. Here the pixels go into a pixel-pack buffer instead (the call
 * returns at once), a fence marks the point in the command stream, and the
 * fence is polled (never waited on) until the GPU has passed it. Only then
 * are the bytes copied out, which no longer waits.
 *
 * GL runs commands in order, so a slot read here can be overwritten by later
 * commands in the same frame: the read sees the pixels from before.
 */
export interface ReadRegion {
  framebuffer: WebGLFramebuffer;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingRead {
  sync: WebGLSync;
  buffer: WebGLBuffer;
  bytes: number;
  done(data: Uint8Array): void;
}

/** How often unfinished reads are polled between frames (ms). */
const POLL_MS = 4;

export class AsyncReads {
  private pending: PendingRead[] = [];
  private timer = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get inFlight(): number {
    return this.pending.length;
  }

  /** Read RGBA8 regions, one after another, into one array passed to `done` when the GPU is finished. */
  read(regions: readonly ReadRegion[], done: (data: Uint8Array) => void): void {
    const gl = this.gl;
    const bytes = regions.reduce((n, r) => n + r.width * r.height * 4, 0);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, Math.max(4, bytes), gl.STREAM_READ);
    let offset = 0;
    for (const r of regions) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
      gl.readPixels(r.x, r.y, r.width, r.height, gl.RGBA, gl.UNSIGNED_BYTE, offset);
      offset += r.width * r.height * 4;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    this.pending.push({ sync, buffer, bytes, done });
    this.schedule();
  }

  /** Deliver every read the GPU has finished. Called each frame and by a timer between frames. */
  poll(): void {
    const gl = this.gl;
    const stillPending: PendingRead[] = [];
    for (const read of this.pending) {
      if (gl.getSyncParameter(read.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
        stillPending.push(read);
        continue;
      }
      const data = new Uint8Array(read.bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(read.buffer);
      gl.deleteSync(read.sync);
      read.done(data);
    }
    this.pending = stillPending;
    if (this.pending.length > 0) this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.poll();
    }, POLL_MS);
  }
}
