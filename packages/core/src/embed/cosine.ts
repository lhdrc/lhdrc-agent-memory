export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function float32ToBytes(v: ArrayLike<number>): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < v.length; i++) {
    view.setFloat32(i * 4, v[i]!, true);
  }
  return new Uint8Array(buf);
}

function asUint8(buf: Uint8Array | Buffer | ArrayBuffer): Uint8Array {
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** P12.1：对齐则零拷贝视图；否则拷到 4 字节对齐缓冲。小端，与 float32ToBytes 一致。 */
export function bytesToFloat32View(buf: Uint8Array | Buffer | ArrayBuffer): Float32Array {
  const bytes = asUint8(buf);
  if (bytes.byteLength % 4 !== 0) {
    const alignedLen = bytes.byteLength - (bytes.byteLength % 4);
    const copy = new Uint8Array(alignedLen);
    copy.set(bytes.subarray(0, alignedLen));
    return new Float32Array(copy.buffer);
  }
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function bytesToFloat32(buf: Uint8Array | Buffer | ArrayBuffer): number[] {
  return Array.from(bytesToFloat32View(buf));
}

export function toFloat32(v: ArrayLike<number>): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}
