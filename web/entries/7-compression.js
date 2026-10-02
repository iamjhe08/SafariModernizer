// CompressionStream / DecompressionStream (Safari 16.4), built on fflate.
import { Gzip, Gunzip, Deflate, Inflate, Zlib, Unzlib } from 'fflate';

if (typeof window.CompressionStream === 'undefined' && typeof TransformStream !== 'undefined') {
  const make = (pick) => function (format) {
    const Engine = pick(String(format));
    if (!Engine) throw new TypeError("Unsupported compression format: '" + format + "'");
    let engine, ctl;
    const ts = new TransformStream({
      start(c) { ctl = c; engine = new Engine((chunk, final) => { if (chunk && chunk.length) ctl.enqueue(chunk); }); },
      transform(chunk) {
        const u8 = chunk instanceof Uint8Array ? chunk : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
        engine.push(u8, false);
      },
      flush() { engine.push(new Uint8Array(0), true); },
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  };
  // "deflate" in the Compression Streams spec means zlib-wrapped; "deflate-raw" is raw deflate
  window.CompressionStream = make((f) => ({ gzip: Gzip, deflate: Zlib, 'deflate-raw': Deflate })[f]);
  window.DecompressionStream = make((f) => ({ gzip: Gunzip, deflate: Unzlib, 'deflate-raw': Inflate })[f]);
}
