import { describe, expect, test } from "bun:test";
import {
  OnnxLocalEmbedding,
  NoopEmbedding,
  createEmbeddingProvider,
  cosineSimilarity,
  float32ToBytes,
  bytesToFloat32,
  ErrorCodes,
} from "../src/index.ts";

describe("P2.1a EmbeddingProvider", () => {
  test("local: same text → identical vectors", async () => {
    const provider = new OnnxLocalEmbedding();
    const text = "支付网关超时重试策略";
    const [a, b] = await provider.embed([text, text]);
    expect(a).toEqual(b);
    expect(a.length).toBe(384);
  });

  test("local: similar Chinese strings have higher cosine than unrelated pair", async () => {
    const provider = new OnnxLocalEmbedding();
    const [v1, v2, v3] = await provider.embed([
      "支付网关超时",
      "网关超时处理",
      "数据库索引优化",
    ]);
    const simRelated = cosineSimilarity(v1!, v2!);
    const simUnrelated = cosineSimilarity(v1!, v3!);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  test("noop.embed throws E_DISABLED", async () => {
    const provider = new NoopEmbedding();
    await expect(provider.embed(["hello"])).rejects.toMatchObject({
      code: ErrorCodes.DISABLED,
    });
  });

  test("factory: off and local providers", () => {
    const off = createEmbeddingProvider({
      provider: "off",
      model: "text-embedding-3-small",
      openai_api_key_env: "OPENAI_API_KEY",
    });
    expect(off.id).toBe("off");
    expect(off.dims).toBe(0);

    const local = createEmbeddingProvider({
      provider: "local",
      model: "hash-ngram",
      openai_api_key_env: "OPENAI_API_KEY",
    });
    expect(local.id).toBe("local");
    expect(local.dims).toBe(384);
  });

  test("float32 roundtrip preserves values", () => {
    const original = [0, 1.5, -2.25, 3.14159, 1e-6];
    const bytes = float32ToBytes(original);
    expect(bytes.byteLength).toBe(original.length * 4);
    const restored = bytesToFloat32(bytes);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});
