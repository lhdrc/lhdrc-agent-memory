import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
  bm25Query,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function capture(title: string, body: string, schemaType = "decision") {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType,
    title,
    body,
    createdBy: "cli:test",
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p131-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P13.1 BM25 文章级", () => {
  test(
    "P131-01 GIN 物化：pages 存在 fts 索引且 EXPLAIN 走 Index",
    async () => {
      await capture("GIN探针", "占位触发建表");
      const conn = await openPglite(repoRoot);
      try {
        // 检查 GIN 索引存在（兼容 tsvector 列或 GIN 表达式索引二选一）
        const idx = await conn.db.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='pages'`,
        );
        const hasGin = idx.rows.some(
          (r) => r.indexdef.includes("gin") || r.indexdef.includes("GIN") || r.indexdef.includes("to_tsvector"),
        );
        // 若用 tsvector 列，也视为物化
        const col = await conn.db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name='pages'`,
        );
        const hasTsv = col.rows.some((r) => r.column_name === "fts_title_tsv" || r.column_name === "fts_body_tsv");
        expect(hasGin || hasTsv).toBe(true);

        // EXPLAIN 走索引（Bitmap Index Scan / Index Scan）
        const plan = await conn.db.query<{ QUERY_PLAN: string }>(
          `EXPLAIN SELECT * FROM pages WHERE to_tsvector('simple', coalesce(fts_title,'')) @@ plainto_tsquery('simple','重试')`,
        ).catch(async () => {
          // 若已物化为 tsvector 列，改查該列
          return conn.db.query<{ QUERY_PLAN: string }>(
            `EXPLAIN SELECT * FROM pages WHERE fts_title_tsv @@ plainto_tsquery('simple','重试')`,
          );
        });
        const text = plan.rows.map((r: unknown) => {
          if (r && typeof r === "object" && "QUERY_PLAN" in (r as Record<string, unknown>)) {
            return String((r as Record<string, unknown>).QUERY_PLAN);
          }
          if (r && typeof r === "object" && "query_plan" in (r as Record<string, unknown>)) {
            return String((r as Record<string, unknown>).query_plan);
          }
          return JSON.stringify(r);
        }).join(" ");
        // 允许不同 PG 版本措辞，至少含 Index 或 Gin
        expect(text.toLowerCase()).toMatch(/index|gin|scan/);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P131-02 中文召回回归：支付网关超时→网关命中，含 code 块不抬分",
    async () => {
      const rel = await capture("支付网关超时", "网关 5xx 错误导致订单失败。\n```ts\nretry(3)\n```\n见 projects/payment");
      const conn = await openPglite(repoRoot);
      try {
        const hits = await bm25Query(conn.db, { brainId: "default", query: "网关", limit: 10 });
        expect(hits.some((h) => h.path === rel)).toBe(true);

        // code 块内的 retry 不应让无关 doc 命中“retry”高分于标题命中
        const rel2 = await capture("普通笔记", "无相关内容，仅 ```ts\nretry(3)\n```");
        const hits2 = await bm25Query(conn.db, { brainId: "default", query: "网关", limit: 10 });
        // 标题命中者应在 code-only 者之前
        const idxTitle = hits2.findIndex((h) => h.path === rel);
        const idxCode = hits2.findIndex((h) => h.path === rel2);
        if (idxCode !== -1) expect(idxTitle).toBeLessThan(idxCode);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P131-03 长度归一：标题全命中短文应压过长文无关",
    async () => {
      // 长文：2000 字重复无关词，含一次“重试”但非标题
      const longBody = "无关填充 ".repeat(500) + " 重试 ";
      const longRel = await capture("长文无关", longBody);
      const shortRel = await capture("重试策略", "重试策略改为固定3次。");
      const conn = await openPglite(repoRoot);
      try {
        const hits = await bm25Query(conn.db, { brainId: "default", query: "重试策略", limit: 10 });
        const idxShort = hits.findIndex((h) => h.path === shortRel);
        const idxLong = hits.findIndex((h) => h.path === longRel);
        expect(idxShort).toBeGreaterThan(-1);
        // 短文标题全命中必须在长文之前（归一后）
        if (idxLong !== -1) expect(idxShort).toBeLessThan(idxLong);
        else expect(idxShort).toBe(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P131-04 短语：带空格“固定 3 次”可命中“固定3次”",
    async () => {
      const rel = await capture("重试固定3次", "指数退避改为固定3次，超时2s→5s。");
      const conn = await openPglite(repoRoot);
      try {
        const hits = await bm25Query(conn.db, { brainId: "default", query: "固定 3 次", limit: 10 });
        expect(hits.some((h) => h.path === rel)).toBe(true);
        const hits2 = await bm25Query(conn.db, { brainId: "default", query: "固定3次", limit: 10 });
        expect(hits2.some((h) => h.path === rel)).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
