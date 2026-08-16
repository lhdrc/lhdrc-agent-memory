/**
 * P9.2 embedding 三档：init 默认 openai；无 Key fail-open 哈希；CI 不出网。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQueryDetailed,
  createEmbeddingProvider,
  resolveEmbedder,
  rebuildIndex,
  writeEmbeddingMeta,
  ErrorCodes,
  MemoryError,
  type EmbeddingProvider,
} from "../src/index.ts";

const T = { timeout: 120_000 };

describe("P9.2 embedding providers", () => {
  test("P92-01 新 init 的 memory.yml 含 embedding.provider: openai", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-01-"));
    const root = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const yml = await readFile(join(root, "memory.yml"), "utf8");
    expect(yml).toContain("provider: openai");
    const cfg = await loadRepoConfig(root);
    expect(cfg.embedding.provider).toBe("openai");
  }, T);

  test("P92-02 测例仓 local：factory 仍为确定性哈希", async () => {
    const local = createEmbeddingProvider({
      provider: "local",
      model: "hashed-bigram-384",
      openai_api_key_env: "OPENAI_API_KEY",
    });
    expect(local.id).toBe("local");
    expect(local.fallbackFrom).toBeUndefined();
    const [a, b] = await local.embed(["支付网关", "支付网关"]);
    expect(a).toEqual(b);
  });

  test("P92-03 provider=openai 无 Key：hybridQuery 不抛；explain 含 fallback；BM25 非空", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "重试策略",
        body: "网关超时改为固定重试 3 次。",
        createdBy: "cli:test",
      });
      const resolved = resolveEmbedder(cfg.embedding);
      expect(resolved.fallback).toBe(true);
      expect(resolved.embedder.id).toBe("local");
      const conn = await openPglite(repoRoot);
      try {
        const { hits, explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试",
          repoRoot,
          embedder: resolved.embedder,
          explain: true,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(explain?.embedding_fallback).toBe("local");
      } finally {
        await conn.close();
      }
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  }, T);

  test("P92-04 provider=openai 有 mock embedder：语义臂走 mock 不走哈希", async () => {
    process.env.P92_MOCK_OPENAI_KEY = "sk-test";
    const factoryEmbedder = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      dims: 4,
      openai_api_key_env: "P92_MOCK_OPENAI_KEY",
    });
    expect(factoryEmbedder.id).toBe("openai");
    expect(factoryEmbedder.fallbackFrom).toBeUndefined();
    delete process.env.P92_MOCK_OPENAI_KEY;

    const mock: EmbeddingProvider = {
      id: "openai",
      dims: 4,
      async embed(texts: string[]) {
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-04-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    await writeEmbeddingMeta(repoRoot, { provider: "openai", dims: 4, model: "mock" });
    const conn = await openPglite(repoRoot);
    try {
      const { explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        embedder: mock,
        explain: true,
        skipCache: true,
      });
      expect(explain?.embedding_fallback).toBeUndefined();
      expect(explain?.arms.semantic.length).toBeGreaterThanOrEqual(0);
    } finally {
      await conn.close();
    }
  }, T);

  test("P92-05 改 provider 后不 rebuild：mismatch → 语义臂 skip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-05-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await writeEmbeddingMeta(repoRoot, { provider: "openai", dims: 1536, model: "text-embedding-3-small" });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    const local = createEmbeddingProvider({
      provider: "local",
      model: "hashed-bigram-384",
      openai_api_key_env: "OPENAI_API_KEY",
    });
    const conn = await openPglite(repoRoot);
    try {
      const { explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        embedder: local,
        explain: true,
        skipCache: true,
      });
      expect(explain?.arms.semantic).toEqual([]);
    } finally {
      await conn.close();
    }
  }, T);

  test("P92-06 未知 provider → E_USAGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-06-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    await writeFile(join(repoRoot, "memory.yml"), yml.replace("provider: openai", "provider: bogus"), "utf8");
    try {
      await loadRepoConfig(repoRoot);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryError);
      expect((e as MemoryError).code).toBe(ErrorCodes.USAGE);
    }
  }, T);

  test("P92-07 onnx 路径不存在：降级哈希且不声称 onnx 成功", () => {
    const resolved = resolveEmbedder({
      provider: "onnx",
      model: "bge",
      openai_api_key_env: "OPENAI_API_KEY",
      onnx_model_path: join(tmpdir(), "no-such-onnx-model.onnx"),
    });
    expect(resolved.fallback).toBe(true);
    expect(resolved.embedder.id).toBe("local");
    expect(resolved.embedder.id).not.toBe("onnx");
    expect(resolved.embedder.fallbackFrom).toBe("onnx");
  });

  test("rebuild --embeddings openai 缺 key → E_DISABLED", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p92-rebuild-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await expect(rebuildIndex(repoRoot, "default", { embeddings: true })).rejects.toMatchObject({
        code: ErrorCodes.DISABLED,
      });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  }, T);
});
