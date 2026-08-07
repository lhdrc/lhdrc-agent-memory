import type { EmbeddingProvider } from "./types.ts";

const DEFAULT_DIMS = 384;

function hashToken(token: string): number {
  let h = 2166136261;
  for (const ch of token) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((x) => x / norm);
}

function embedOne(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const cps = [...text];
  if (cps.length === 0) return vec;

  for (let i = 0; i < cps.length - 1; i++) {
    const bigram = cps[i]! + cps[i + 1]!;
    const h = hashToken(bigram);
    const idx = h % dims;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx]! += sign;
  }
  if (cps.length === 1) {
    const h = hashToken(cps[0]!);
    vec[h % dims]! += 1;
  }
  return l2Normalize(vec);
}

export class OnnxLocalEmbedding implements EmbeddingProvider {
  readonly id = "local";
  readonly dims: number;

  constructor(dims = DEFAULT_DIMS) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedOne(t, this.dims));
  }
}
