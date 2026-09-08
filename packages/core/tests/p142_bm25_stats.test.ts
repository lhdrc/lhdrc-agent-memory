import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadPack,
  captureNode,
  openPglite,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
} from "../src/index.ts";
import { bm25Saturate, BM25_K1, BM25_B } from "../src/retrieve/query.ts";
import { refreshCorpusStats } from "../src/index/stats.ts";

const T = 120000;
let repoRoot: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p142-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

async function capture(title: string, body: string) {
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: "note",
    title,
    body,
    createdBy: "cli:test",
  });
}

describe("P14.2 BM25 半真实打分", () => {
  test("P142-U01 饱和函数：高频收益递减，短文不被系统性压制", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
    // 同一 avgdl 下，raw 翻倍带来的增益小于翻倍（饱和）
    const s1 = bm25Saturate(2, 100, 100);
    const s2 = bm25Saturate(4, 100, 100);
    expect(s2 / s1).toBeLessThan(2);
    expect(s2).toBeGreaterThan(s1);
    // 同一 raw 下，短文得分高于长文
    expect(bm25Saturate(2, 50, 100)).toBeGreaterThan(bm25Saturate(2, 400, 100));
  });

  test(
    "P142-01 sync 落库写 doc_len",
    async () => {
      const rel = await capture("重试策略", "网关超时改为固定重试三次。");
      const conn = await openPglite(repoRoot);
      try {
        const rows = await conn.db.query<{ doc_len: number }>(`SELECT doc_len FROM pages WHERE path = $1`, [rel]);
        expect(Number(rows.rows[0]!.doc_len)).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P142-02 refreshCorpusStats 落 corpus_stats 行",
    async () => {
      await capture("短", "重试。");
      await capture("长", `重试。${"无关填充文字混合 filler words padding ".repeat(60)}`);
      const conn = await openPglite(repoRoot);
      try {
        await refreshCorpusStats(conn.db, "default");
        const rows = await conn.db.query<{ n: number; avgdl: number }>(
          `SELECT n, avgdl FROM corpus_stats WHERE brain_id = $1`,
          ["default"],
        );
        expect(Number(rows.rows[0]!.n)).toBe(2);
        expect(Number(rows.rows[0]!.avgdl)).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P142-03 无统计行时查询可用（回退旧公式）",
    async () => {
      const rel = await capture("重试策略", "网关超时改为固定重试三次。");
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`DELETE FROM corpus_stats WHERE brain_id = $1`, ["default"]);
        const { bm25Query } = await import("../src/retrieve/query.ts");
        const hits = await bm25Query(conn.db, { brainId: "default", query: "重试", limit: 10 });
        expect(hits.some((h) => h.path === rel)).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
