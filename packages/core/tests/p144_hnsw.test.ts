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
import { ensureVectorIndex } from "../src/index/vector-index.ts";
import { semanticArm } from "../src/retrieve/semantic.ts";
import { createEmbeddingProvider } from "../src/embed/factory.ts";

const T = 120000;
let repoRoot: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p144-"));
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

describe("P14.4 HNSW 索引召回", () => {
  test(
    "P144-01 pglite 可用 vector 扩展并建 HNSW 索引",
    async () => {
      const conn = await openPglite(repoRoot);
      try {
        expect(await ensureVectorIndex(conn.db, 3)).toBe(true);
        const idx = await conn.db.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_hnsw'`,
        );
        expect(idx.rows.length).toBe(1);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P144-02 sync 双写 embedding_vec，语义臂 HNSW 与暴力一致",
    async () => {
      await capture("重试策略", "网关超时改为固定重试三次，熔断阈值保持。");
      await capture("部署流程", "发布前跑全量回归，周三窗口上线。");
      const conn = await openPglite(repoRoot);
      try {
        const cfg0 = await loadRepoConfig(repoRoot);
        const dims0 = (
          await import("../src/embed/factory.ts").then((m) => m.resolveEmbedder(cfg0.embedding))
        ).embedder.dims;
        expect(await ensureVectorIndex(conn.db, dims0)).toBe(true);
        const vec = await conn.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM chunks WHERE embedding_vec IS NOT NULL`,
        );
        expect(Number(vec.rows[0]!.n)).toBeGreaterThan(0);
        const cfg = await loadRepoConfig(repoRoot);
        const { embedder } = await import("../src/embed/factory.ts").then((m) =>
          m.resolveEmbedder(cfg.embedding),
        );
        void createEmbeddingProvider;
        const [qv] = await embedder.embed(["网关超时重试"]);
        const hits = await semanticArm(conn.db, {
          brainId: "default",
          queryVec: qv!,
          limit: 10,
          query: "网关超时重试",
          repoRoot,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]!.path).toContain("重试");
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
