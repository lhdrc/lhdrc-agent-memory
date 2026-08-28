import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  rebuildIndex,
  createEmbeddingProvider,
  semanticArm,
  isSemanticScoreSql,
  cosineSimilarity,
  float32ToBytes,
  bytesToFloat32,
  bytesToFloat32View,
  OpenAIEmbedding,
  syncPage,
  ErrorCodes,
  MemoryError,
  invalidateEmbeddingCache,
  type SqlClient,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;

const T = { timeout: 30_000 };

function wrapQuery(db: SqlClient): { db: SqlClient; sqls: string[] } {
  const sqls: string[] = [];
  const wrapped: SqlClient = {
    engine: db.engine,
    pgvector: db.pgvector,
    query: async <T>(sql: string, params?: unknown[]) => {
      sqls.push(sql);
      return db.query<T>(sql, params);
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
  return { db: wrapped, sqls };
}

async function setEmbeddingProvider(provider: "off" | "local") {
  const p = join(repoRoot, "memory.yml");
  let yml = await readFile(p, "utf8");
  yml = yml.replace(/provider:\s*\w+/, `provider: ${provider}`);
  await writeFile(p, yml, "utf8");
}

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function capture(title: string, body: string) {
  const pack = await loadPack("problem-tree");
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title,
    body,
    createdBy: "cli:test",
  });
}

beforeEach(async () => {
  invalidateEmbeddingCache();
  dir = await mkdtemp(join(tmpdir(), "dfmem-p121-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("P12.1 嵌入热路径", () => {
  test("P121-01 Float32 视图与 number[] 余弦一致", () => {
    const original = [0, 1.5, -2.25, 3.14159, 1e-6, 0.125];
    const bytes = float32ToBytes(original);
    const asArr = bytesToFloat32(bytes);
    const asView = bytesToFloat32View(bytes);
    const q = [0.2, -0.1, 0.4, 0.8, 0.01, 0.5];
    expect(Math.abs(cosineSimilarity(q, asArr) - cosineSimilarity(q, asView))).toBeLessThanOrEqual(1e-5);
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    const misaligned = bytesToFloat32View(padded.subarray(1));
    expect(Math.abs(cosineSimilarity(q, asArr) - cosineSimilarity(q, misaligned))).toBeLessThanOrEqual(1e-5);
  });

  test(
    "P121-02 semanticArm local 相关 path 靠前",
    async () => {
      await setEmbeddingProvider("local");
      const rel = await capture("支付网关超时", "网关 5xx 错误导致订单失败，需要超时重试。");
      await capture("数据库索引", "B-tree 与顺序扫描无关的优化笔记。");
      await rebuildIndex(repoRoot, "default", { embeddings: true });
      const cfg = await loadRepoConfig(repoRoot);
      const embedder = createEmbeddingProvider(cfg.embedding);
      const [qv] = await embedder.embed(["网关超时"]);
      const conn = await openPglite(repoRoot);
      try {
        const hits = await semanticArm(conn.db, {
          brainId: "default",
          queryVec: qv!,
          limit: 5,
          query: "网关超时",
          repoRoot,
        });
        expect(hits[0]?.path).toBe(rel);
        expect(hits[0]?.evidence).toContain("semantic");
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P121-03 打分 SQL 不含 text/title；winner 再取",
    async () => {
      await setEmbeddingProvider("local");
      await capture("向量打分", "语义臂只应拉取 embedding 再回头取 snippet。");
      await rebuildIndex(repoRoot, "default", { embeddings: true });
      const cfg = await loadRepoConfig(repoRoot);
      const embedder = createEmbeddingProvider(cfg.embedding);
      const [qv] = await embedder.embed(["snippet"]);
      const conn = await openPglite(repoRoot);
      try {
        const { db, sqls } = wrapQuery(conn.db);
        await semanticArm(db, {
          brainId: "default",
          queryVec: qv!,
          limit: 5,
          query: "snippet",
          repoRoot,
        });
        const scoreSqls = sqls.filter((s) => isSemanticScoreSql(s));
        expect(scoreSqls.length).toBeGreaterThan(0);
        for (const s of scoreSqls) {
          expect(s).not.toMatch(/\bc\.text\b/);
          expect(s).not.toMatch(/\bp\.title\b/);
        }
        expect(sqls.some((s) => /\bc\.text\b/.test(s) && /\bp\.title\b/.test(s))).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P121-04 进程内缓存第二次跳过打分 SELECT",
    async () => {
      await setEmbeddingProvider("local");
      await capture("缓存甲", "第一篇用于缓存命中测试的网关超时。");
      await capture("缓存乙", "第二篇无关的数据库索引说明。");
      await rebuildIndex(repoRoot, "default", { embeddings: true });
      const cfg = await loadRepoConfig(repoRoot);
      const embedder = createEmbeddingProvider(cfg.embedding);
      const [qv] = await embedder.embed(["网关超时"]);
      const armOpts = {
        brainId: "default",
        queryVec: qv!,
        limit: 5,
        query: "网关超时",
        repoRoot,
      };

      const conn = await openPglite(repoRoot);
      try {
        const { db, sqls } = wrapQuery(conn.db);
        await semanticArm(db, armOpts);
        expect(sqls.filter((s) => isSemanticScoreSql(s)).length).toBeGreaterThan(0);
        sqls.length = 0;
        await semanticArm(db, armOpts);
        expect(sqls.filter((s) => isSemanticScoreSql(s)).length).toBe(0);
      } finally {
        await conn.close();
      }

      const wipe = await openPglite(repoRoot);
      try {
        await wipe.db.query(`UPDATE chunks SET embedding = NULL`);
      } finally {
        await wipe.close();
      }
      await rebuildIndex(repoRoot, "default", { pendingEmbeddings: true });

      const conn2 = await openPglite(repoRoot);
      try {
        const { db, sqls } = wrapQuery(conn2.db);
        await semanticArm(db, armOpts);
        expect(sqls.filter((s) => isSemanticScoreSql(s)).length).toBeGreaterThan(0);
      } finally {
        await conn2.close();
      }
    },
    T,
  );

  test(
    "P121-05 --pending-embeddings 填 NULL 且不清 pages",
    async () => {
      await setEmbeddingProvider("off");
      const rel = await capture("待嵌入", "capture 时 provider=off，chunk 无向量。");
      const conn0 = await openPglite(repoRoot);
      let hashBefore = "";
      try {
        const nulls = await conn0.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL`,
        );
        expect(Number(nulls.rows[0]?.n ?? 0)).toBeGreaterThan(0);
        const page = await conn0.db.query<{ content_hash: string }>(
          `SELECT content_hash FROM pages WHERE path = $1`,
          [rel],
        );
        hashBefore = String(page.rows[0]?.content_hash ?? "");
        expect(hashBefore.length).toBeGreaterThan(0);
      } finally {
        await conn0.close();
      }

      await setEmbeddingProvider("local");
      const { pendingEmbedded } = await rebuildIndex(repoRoot, "default", { pendingEmbeddings: true });
      expect(pendingEmbedded ?? 0).toBeGreaterThan(0);

      const conn1 = await openPglite(repoRoot);
      try {
        const filled = await conn1.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL`,
        );
        expect(Number(filled.rows[0]?.n ?? 0)).toBeGreaterThan(0);
        const stillNull = await conn1.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL`,
        );
        expect(Number(stillNull.rows[0]?.n ?? 0)).toBe(0);
        const page = await conn1.db.query<{ content_hash: string; path: string }>(
          `SELECT path, content_hash FROM pages WHERE path = $1`,
          [rel],
        );
        expect(page.rows[0]?.path).toBe(rel);
        expect(page.rows[0]?.content_hash).toBe(hashBefore);
      } finally {
        await conn1.close();
      }
    },
    T,
  );

  test("P121-06 embeddings 与 pending-embeddings 互斥", async () => {
    await expect(
      rebuildIndex(repoRoot, "default", { embeddings: true, pendingEmbeddings: true }),
    ).rejects.toMatchObject({
      code: ErrorCodes.USAGE,
    });
  });

  test("P121-07 embeddings 500 重试成功；400 不重试", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      let calls = 0;
      const okBody = JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      const provider = new OpenAIEmbedding(
        {
          provider: "openai",
          model: "text-embedding-3-small",
          dims: 3,
          openai_api_key_env: "OPENAI_API_KEY",
        },
        {
          sleep: async () => {},
          fetch: async () => {
            calls++;
            if (calls === 1) return new Response("nope", { status: 500, statusText: "ERR" });
            return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
          },
        },
      );
      const vecs = await provider.embed(["hello"]);
      expect(calls).toBe(2);
      expect(vecs[0]).toEqual([0.1, 0.2, 0.3]);

      let badCalls = 0;
      const bad = new OpenAIEmbedding(
        {
          provider: "openai",
          model: "text-embedding-3-small",
          dims: 3,
          openai_api_key_env: "OPENAI_API_KEY",
        },
        {
          sleep: async () => {},
          fetch: async () => {
            badCalls++;
            return new Response("bad", { status: 400, statusText: "Bad Request" });
          },
        },
      );
      await expect(bad.embed(["hello"])).rejects.toMatchObject({ code: ErrorCodes.INDEX });
      expect(badCalls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test(
    "P121-08 syncPage embed 失败仍留下 page/chunks NULL 向量",
    async () => {
      await setEmbeddingProvider("local");
      const rel = "brains/default/sources/default/p121-08-note.md";
      const absDir = join(repoRoot, "brains/default/sources/default");
      await mkdir(absDir, { recursive: true });
      await writeFile(
        join(repoRoot, rel),
        `---\ntitle: embed fail\nschema_type: note\n---\n\nbody for pending resume\n`,
        "utf8",
      );
      const boom = {
        id: "local",
        dims: 384,
        embed: async () => {
          throw new Error("embed boom");
        },
      };
      const conn = await openPglite(repoRoot);
      try {
        await expect(syncPage(conn.db, repoRoot, rel, { embedder: boom })).rejects.toBeInstanceOf(MemoryError);
        const pages = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages WHERE path = $1`, [rel]);
        expect(Number(pages.rows[0]?.n ?? 0)).toBe(1);
        const chunks = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM chunks WHERE path = $1`, [rel]);
        expect(Number(chunks.rows[0]?.n ?? 0)).toBeGreaterThan(0);
        const nulls = await conn.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE path = $1 AND embedding IS NULL`,
          [rel],
        );
        expect(Number(nulls.rows[0]?.n ?? 0)).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
