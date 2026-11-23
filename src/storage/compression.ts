/**
 * Lossless compression with the browser's built-in `CompressionStream`
 * (raw deflate). Used for evicted tiles in memory (Phase 2) and for every
 * object saved to disk (Phase 4). Available on the main thread, in workers
 * and in Node, so the same code is unit-tested.
 */

export async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  return transform(raw, new CompressionStream('deflate-raw'));
}

export async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  return transform(compressed, new DecompressionStream('deflate-raw'));
}

async function transform(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(input as Uint8Array<ArrayBuffer>);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
