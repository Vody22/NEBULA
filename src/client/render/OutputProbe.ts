/**
 * Samples a 7 × 7 grid of the frame just drawn on screen without stalling.
 * A plain readPixels waits for the GPU to finish the whole frame, which costs
 * a refresh at 144–165 Hz; here the pixels are copied into a GPU buffer and
 * read back a few frames later, once a fence says the copy is done.
 */
export class OutputProbe {
  private buffer: WebGLBuffer | null = null;
  private sync: WebGLSync | null = null;
  private data = new Uint8Array(49 * 4);

  constructor(private gl: WebGL2RenderingContext) {}

  /** A sample is on its way. */
  get busy() {
    return this.sync !== null;
  }

  /** Starts a sample of the screen framebuffer, which must be bound. */
  start() {
    const gl = this.gl;
    this.cancel();
    if (!this.buffer) {
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.data.byteLength, gl.STREAM_READ);
    } else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    let k = 0;
    for (let i = 1; i < 8; i++)
      for (let j = 1; j < 8; j++)
        gl.readPixels(Math.floor((gl.drawingBufferWidth * i) / 8), Math.floor((gl.drawingBufferHeight * j) / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 4 * k++);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** The brightest channel of the sample (0–255) once it has arrived, else null. */
  poll(): number | null {
    const gl = this.gl;
    if (!this.sync) return null;
    const status = gl.clientWaitSync(this.sync, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(this.sync);
    this.sync = null;
    if (status === gl.WAIT_FAILED) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    let max = 0;
    for (let i = 0; i < this.data.length; i += 4) max = Math.max(max, this.data[i], this.data[i + 1], this.data[i + 2]);
    return max;
  }

  /** Drops a sample still on its way (the render path changed meanwhile). */
  cancel() {
    if (!this.sync) return;
    this.gl.deleteSync(this.sync);
    this.sync = null;
  }
}
