export function cosineSimilarity(a: number[], b: number[]): number {
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

export function float32ToBytes(v: number[]): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < v.length; i++) {
    view.setFloat32(i * 4, v[i]!, true);
  }
  return new Uint8Array(buf);
}

export function bytesToFloat32(buf: Uint8Array | Buffer | ArrayBuffer): number[] {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4) {
    out.push(view.getFloat32(i, true));
  }
  return out;
}
