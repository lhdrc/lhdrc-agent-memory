/**
 * P14.5 rerank local 加强 - TDD
 * P145-01 默认 off 零影响
 * P145-02 local 加强（邻近度 + 多证据）
 * P145-03 --explain 透出 rerank 贡献，缺模型 skipped 不炸
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadPack,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQueryDetailed,
  DEFAULT_SEARCH_CONFIG,
} from "../src/index.ts";
import { localRerank, localRerankScore } from "../src/retrieve/rerank.ts";
import type { QueryHit } from "../src/retrieve/query.ts";

const T = { timeout: 60_000 };

function makeHit(path: string, title: string, snippet: string, score = 1): QueryHit {
  return { path, title, snippet, score, evidence: [] };
}

describe("P14.5 rerank local", () => {
  test("P145-01 default rerank off 零影响", () => {
    expect(DEFAULT_SEARCH_CONFIG.tokenmax.rerank).toBe("off");
    expect(DEFAULT_SEARCH_CONFIG.tokenmax.rerank_top_n).toBe(20);
  });

  test("P145-01 off 链路排序与基线一致（不调 rerank）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p145-off-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "支付回调 A",
      body: "支付回调内容 A",
      createdBy: "cli:test",
    });
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "支付回调 B",
      body: "支付回调内容 B",
      createdBy: "cli:test",
    });
    const conn = await openPglite(repoRoot);
    try {
      const res = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "支付回调",
        repoRoot,
        explain: true,
        skipCache: true,
      });
      expect(res.explain?.rerank).toBe("off");
      // off 时不应有 rerank_scores
      expect(res.explain?.rerank_scores).toBeUndefined();
    } finally {
      await conn.close();
    }
  }, T);

  test("P145-02a 邻近度：query 词共现窗口越近分数越高", () => {
    // 用 "ab xy" 让 bigram 覆盖相等（都含 ab, xy 缺 bx），phrase 都不含（用逗号隔开），仅邻近度区分
    const q = "ab xy";
    const title = "test";
    const closeSnippet = "ab, xy together"; // 邻近：ab 与 xy 间距 2
    const farSnippet = "ab " + "x ".repeat(30) + " xy far apart"; // 间距 >60
    const closeScore = localRerankScore(q, title, closeSnippet);
    const farScore = localRerankScore(q, title, farSnippet);
    // 加强前两者分数相等（phrase 0, bigram 1.0），加强后 close > far
    expect(closeScore).toBeGreaterThan(farScore);
    // 邻近度至少带来 0.5 分以上差距
    expect(closeScore - farScore).toBeGreaterThanOrEqual(0.5);
  });

  test("P145-02b 多证据：命中更多 distinto query 词种类分数更高", () => {
    // 用 "ab xy"：多证据 many 含 2 种，single 只含 1 种，但 bigram 仅差 0.5，未达 1 分，靠多证据拉开
    const q = "ab xy";
    const title = "test";
    const manySnippet = "ab, xy both present";
    const singleSnippet = "ab ab ab only one kind";
    const manyScore = localRerankScore(q, title, manySnippet);
    const singleScore = localRerankScore(q, title, singleSnippet);
    expect(manyScore).toBeGreaterThan(singleScore);
    // 加强前 many - single = 0.5（bigram：ab+xy vs ab），加强后应 >=1（多证据额外 +1）
    expect(manyScore - singleScore).toBeGreaterThanOrEqual(1);
  });

  test("P145-02c 保留短语/标题/bigram 行为", () => {
    const q = "支付回调";
    const titleHit = "支付回调";
    const titleMiss = "其他标题";
    const snippet = "支付回调正文";
    const s1 = localRerankScore(q, titleHit, snippet);
    const s2 = localRerankScore(q, titleMiss, snippet);
    expect(s1).toBeGreaterThan(s2);

    // bigram 行为保留：含 bigram 应 > 不含
    const qEn = "retry policy";
    const withBigram = localRerankScore(qEn, "t", "retry policy present");
    const withoutBigram = localRerankScore(qEn, "t", "nothing relevant here");
    expect(withBigram).toBeGreaterThan(withoutBigram);
  });

  test("P145-02d 只重排 topN 逻辑不动", () => {
    const q = "alpha";
    const hits: QueryHit[] = [
      makeHit("p1", "alpha", "alpha close", 10),
      makeHit("p2", "other", "no hit", 9),
      makeHit("p3", "other", "no hit", 8),
      makeHit("p4", "alpha", "alpha far but beyond topN", 7),
    ];
    const topN = 2;
    const reranked = localRerank(q, hits, topN);
    // 前 topN 内可重排，topN 之外的 p4 应仍在末尾未被提前
    expect(reranked.slice(topN).map((h) => h.path)).toEqual(["p3", "p4"]);
    // head 内排序应按 rerankScore
    const headPaths = reranked.slice(0, topN).map((h) => h.path);
    expect(headPaths).toContain("p1");
  });

  test("P145-03 --explain 含 rerank 状态与贡献；缺模型 skipped 不炸", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p145-explain-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "rerank 解释测试",
      body: "alpha beta gamma 内容",
      createdBy: "cli:test",
    });
    const conn = await openPglite(repoRoot);
    try {
      // local 档
      const localRes = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "alpha beta",
        repoRoot,
        explain: true,
        skipCache: true,
        search: {
          ...DEFAULT_SEARCH_CONFIG,
          tokenmax: { ...DEFAULT_SEARCH_CONFIG.tokenmax, rerank: "local", rerank_top_n: 20 },
        },
      });
      expect(localRes.explain?.rerank).toBe("local");
      // explain 需透出 rerank 贡献： score_details.rerank（沿用 score_details 思路）
      expect((localRes.explain?.rerank_scores?.length ?? 0) > 0).toBe(true);
      const hasScoreDetailsRerank = localRes.explain?.score_details?.some((d) => typeof (d as any).rerank === "number");
      expect(hasScoreDetailsRerank).toBe(true);

      // model 档但 fn 抛 E_DISABLED -> skipped 或降级 local，不炸
      const { MemoryError, ErrorCodes } = await import("../src/errors.ts");
      const skippedRes = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "alpha beta",
        repoRoot,
        mode: "tokenmax",
        explain: true,
        skipCache: true,
        search: {
          ...DEFAULT_SEARCH_CONFIG,
          tokenmax: { ...DEFAULT_SEARCH_CONFIG.tokenmax, rerank: "model", rerank_top_n: 20 },
        },
        rerankFn: () => {
          throw new MemoryError(ErrorCodes.LLM, "E_DISABLED: cross-encoder weight missing", { cause: "no weight" });
        },
      });
      expect(["skipped", "local"].includes(skippedRes.explain?.rerank ?? "")).toBe(true);
      expect(skippedRes.hits.length).toBeGreaterThanOrEqual(0);
      // score_details 仍应存在且不炸
      expect(Array.isArray(skippedRes.explain?.score_details)).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P145-cross-encoder 插槽：rerankFn 注入点为正式接口，off 时不调用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p145-slot-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "slot test",
      body: "alpha beta",
      createdBy: "cli:test",
    });
    let called = 0;
    const conn = await openPglite(repoRoot);
    try {
      const res = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "alpha",
        repoRoot,
        explain: true,
        skipCache: true,
        search: { ...DEFAULT_SEARCH_CONFIG, tokenmax: { ...DEFAULT_SEARCH_CONFIG.tokenmax, rerank: "off" } },
        rerankFn: async (_q, hits) => {
          called++;
          return hits;
        },
      });
      expect(called).toBe(0);
      expect(res.explain?.rerank).toBe("off");
    } finally {
      await conn.close();
    }
  }, T);
});
