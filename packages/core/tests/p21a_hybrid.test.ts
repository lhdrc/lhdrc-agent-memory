import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  hybridQuery,
  rebuildIndex,
  createEmbeddingProvider,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 30_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function setEmbeddingProvider(provider: "off" | "local") {
  const p = join(repoRoot, "memory.yml");
  let yml = await readFile(p, "utf8");
  yml = yml.replace(/provider:\s*\w+/, `provider: ${provider}`);
  await writeFile(p, yml, "utf8");
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

async function hybrid(
  q: string,
  opts?: { mode?: "conservative" | "balanced" | "tokenmax"; limit?: number },
) {
  const cfg = await loadRepoConfig(repoRoot);
  const embedder =
    cfg.embedding.provider !== "off" ? createEmbeddingProvider(cfg.embedding) : null;
  const conn = await openPglite(repoRoot);
  try {
    return await hybridQuery(conn.db, {
      brainId: "default",
      query: q,
      limit: opts?.limit ?? 10,
      mode: opts?.mode ?? cfg.search.mode,
      embedder,
      repoRoot,
    });
  } finally {
    await conn.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p21a-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P2.1a 混合检索", () => {
  test(
    "P21a-01 provider=off → hybridQuery 仍可用（BM25 only）",
    async () => {
      await setEmbeddingProvider("off");
      const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const hits = await hybrid("重试");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.path).toBe(rel);
      expect(hits[0]!.evidence).toContain("keyword");
      expect(hits[0]!.evidence).not.toContain("semantic");
    },
    T,
  );

  test(
    "P21a-02 provider=local + embeddings → balanced 命中含 semantic evidence",
    async () => {
      await setEmbeddingProvider("local");
      const rel = await capture("支付网关超时", "网关 5xx 错误导致订单失败，需要超时重试。");
      await rebuildIndex(repoRoot, "default", { embeddings: true });

      const balanced = await hybrid("网关超时", { mode: "balanced" });

      const hit = balanced.find((h) => h.path === rel);
      expect(hit).toBeDefined();
      expect(hit!.evidence).toContain("semantic");
    },
    T,
  );

  test(
    "P21a-03 fused 结果按 path 唯一",
    async () => {
      await setEmbeddingProvider("local");
      await capture("支付网关超时", "网关超时与重试策略。");
      await capture("数据库索引", "B-tree 索引优化。");
      await rebuildIndex(repoRoot, "default");

      const hits = await hybrid("网关", { limit: 10 });
      const paths = hits.map((h) => h.path);
      expect(new Set(paths).size).toBe(paths.length);
    },
    T,
  );

  test(
    "P21a-05 rebuild --embeddings + local → chunks.embedding 非空",
    async () => {
      await setEmbeddingProvider("local");
      await capture("向量测试", "embedding 写入校验 body。");
      await rebuildIndex(repoRoot, "default", { embeddings: true });

      const conn = await openPglite(repoRoot);
      try {
        const r = await conn.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL`,
        );
        expect(Number(r.rows[0]?.n ?? 0)).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
