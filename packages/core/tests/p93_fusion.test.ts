/**
 * P9.3 融合 rescale / floor / cosine re-score / hotness 乘法
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
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
  fuseHybridArms,
  rescaleRrf,
  RRF_K,
  TIE_BREAK_EPS,
  DEFAULT_SEARCH_CONFIG,
  float32ToBytes,
  writeEmbeddingMeta,
  type EmbeddingProvider,
  type SearchConfig,
} from "../src/index.ts";

const T = { timeout: 120_000 };

describe("P9.3 fusion rescale", () => {
  test("P93-01 单臂 rank1 的 rrfBm25 ≈ 1.0", () => {
    const out = fuseHybridArms([{ path: "p1" }], [], {
      mode: "conservative",
      query: "x",
      titles: new Map([["p1", "x"]]),
      semanticAvailable: false,
    });
    expect(out[0]!.rrfBm25).toBeCloseTo(1.0, 2);
    expect(rescaleRrf(1 / (RRF_K + 1))).toBeCloseTo(1.0, 10);
  });

  test("P93-03 源码无 HOTNESS_WEIGHT = 0.45 加法", async () => {
    const src = await readFile(join(import.meta.dir, "../src/retrieve/hotness.ts"), "utf8");
    expect(src).not.toContain("HOTNESS_WEIGHT = 0.45");
    expect(src).toContain("1 +");
  });

  test("P93-04 per_arm_min=0.99 时融合列表变短", () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}` }));
    const loose = fuseHybridArms(hits, [], {
      mode: "conservative",
      query: "zzz",
      titles: new Map(hits.map((h) => [h.path, h.path])),
      semanticAvailable: false,
      fusion: { ...DEFAULT_SEARCH_CONFIG.fusion, per_arm_min: 0, fused_min: 0 },
      limit: 40,
    });
    const tight = fuseHybridArms(hits, [], {
      mode: "conservative",
      query: "zzz",
      titles: new Map(hits.map((h) => [h.path, h.path])),
      semanticAvailable: false,
      fusion: { ...DEFAULT_SEARCH_CONFIG.fusion, per_arm_min: 0.99, fused_min: 0.05 },
      limit: 40,
    });
    expect(tight.length).toBeLessThan(loose.length);
    expect(tight.length).toBeLessThanOrEqual(5);
  });

  test("P93-10 TIE_BREAK_EPS=0.002 且 k=60", () => {
    expect(TIE_BREAK_EPS).toBe(0.002);
    expect(RRF_K).toBe(60);
    expect(DEFAULT_SEARCH_CONFIG.fusion.rrf_k).toBe(60);
    expect(DEFAULT_SEARCH_CONFIG.hotness.alpha).toBe(0.15);
    expect(DEFAULT_SEARCH_CONFIG.tokenmax.rerank).toBe("off");
  });
});

describe("P9.3 hybrid pipeline", () => {
  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p93-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    return { repoRoot, pack, cfg, queue };
  }

  test("P93-02 标题全命中的旧文档 score 高于无关新文档", async () => {
    const { repoRoot, pack, queue } = await boot();
    const oldPath = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    const newPath = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "今日天气",
      body: "晴。顺带一提重试这个词出现过。",
      createdBy: "cli:test",
    });
    const conn = await openPglite(repoRoot);
    try {
      await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
        new Date(Date.now() - 400 * 86_400_000).toISOString(),
        oldPath,
      ]);
      await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
        new Date().toISOString(),
        newPath,
      ]);
      const { hits } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试策略",
        repoRoot,
        skipCache: true,
        search: { ...DEFAULT_SEARCH_CONFIG, hotness: { enabled: true, half_life_days: 30, alpha: 0.15 } },
      });
      const oldHit = hits.find((h) => h.path === oldPath);
      const newHit = hits.find((h) => h.path === newPath);
      expect(oldHit).toBeDefined();
      if (newHit && oldHit) {
        expect(oldHit.score).toBeGreaterThan(newHit.score);
      }
    } finally {
      await conn.close();
    }
  }, T);

  test("P93-05 embedding.provider=off：cosine skipped", async () => {
    const { repoRoot, pack, queue } = await boot();
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "固定 3 次。",
      createdBy: "cli:test",
    });
    const conn = await openPglite(repoRoot);
    try {
      const { explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        embedder: { id: "off", dims: 0, embed: async () => [] },
        explain: true,
        skipCache: true,
      });
      expect(explain?.fusion?.cosine).toBe("skipped");
    } finally {
      await conn.close();
    }
  }, T);

  test("P93-06 哈希档 cosine 仍运行", async () => {
    const { repoRoot, pack, queue } = await boot();
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "固定 3 次。",
      createdBy: "cli:test",
    });
    const { createEmbeddingProvider } = await import("../src/index.ts");
    const embedder = createEmbeddingProvider({
      provider: "local",
      model: "hash",
      dims: 1536,
      openai_api_key_env: "OPENAI_API_KEY",
    });
    const conn = await openPglite(repoRoot);
    try {
      const { explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        embedder,
        explain: true,
        skipCache: true,
      });
      expect(explain?.fusion?.cosine).toBe("applied");
    } finally {
      await conn.close();
    }
  }, T);

  test("P93-07 mock embedder：同向量 hit 排在正交 hit 前", async () => {
    const { repoRoot, pack, queue } = await boot();
    const samePath = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "向量对齐",
      body: "alpha token shared retrieval blob one",
      createdBy: "cli:test",
    });
    const orthPath = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "向量正交",
      body: "alpha token shared retrieval blob two",
      createdBy: "cli:test",
    });
    const mock: EmbeddingProvider = {
      id: "openai",
      dims: 2,
      async embed() {
        return [[1, 0]];
      },
    };
    await writeEmbeddingMeta(repoRoot, { provider: "openai", dims: 2, model: "mock" });
    const conn = await openPglite(repoRoot);
    try {
      await conn.db.query(`UPDATE chunks SET embedding = $1 WHERE path = $2`, [
        float32ToBytes([1, 0]),
        samePath,
      ]);
      await conn.db.query(`UPDATE chunks SET embedding = $1 WHERE path = $2`, [
        float32ToBytes([0, 1]),
        orthPath,
      ]);
      const { hits } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "alpha token",
        repoRoot,
        embedder: mock,
        explain: true,
        skipCache: true,
        search: {
          ...DEFAULT_SEARCH_CONFIG,
          fusion: { ...DEFAULT_SEARCH_CONFIG.fusion, cosine_lambda: 0.3 },
          hotness: { enabled: false, half_life_days: 30, alpha: 0 },
        },
      });
      const iSame = hits.findIndex((h) => h.path === samePath);
      const iOrth = hits.findIndex((h) => h.path === orthPath);
      expect(iSame).toBeGreaterThanOrEqual(0);
      expect(iOrth).toBeGreaterThanOrEqual(0);
      expect(iSame).toBeLessThan(iOrth);
    } finally {
      await conn.close();
    }
  }, T);

  test("P93-08 rerank model 且 fn throw → 回退 local，query 不抛", async () => {
    const { repoRoot, pack, queue } = await boot();
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "固定 3 次。",
      createdBy: "cli:test",
    });
    const search: SearchConfig = {
      ...DEFAULT_SEARCH_CONFIG,
      tokenmax: { ...DEFAULT_SEARCH_CONFIG.tokenmax, rerank: "model" },
    };
    const conn = await openPglite(repoRoot);
    try {
      const { hits, explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        mode: "tokenmax",
        search,
        explain: true,
        skipCache: true,
        rerankFn: () => {
          throw new Error("model down");
        },
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(explain?.rerank === "local" || explain?.rerank === "skipped").toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P93-09 默认 rerank off；balanced 不调 complete", async () => {
    const { repoRoot, pack, queue } = await boot();
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "固定 3 次。",
      createdBy: "cli:test",
    });
    let completeCalls = 0;
    const conn = await openPglite(repoRoot);
    try {
      const { explain } = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        repoRoot,
        mode: "balanced",
        explain: true,
        skipCache: true,
        rerankFn: async (q, hits) => {
          completeCalls += 1;
          return hits;
        },
      });
      expect(explain?.rerank).toBe("off");
      expect(completeCalls).toBe(0);
    } finally {
      await conn.close();
    }
  }, T);
});
