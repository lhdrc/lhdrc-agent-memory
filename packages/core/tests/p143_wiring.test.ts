import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryRepo, loadPack, captureNode, openPglite, loadRepoConfig, WriteQueue, pgliteIndexHooks } from "../src/index.ts";

const T = 120000;
let dir: string;
let repoRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p143w-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("P14.3 接线：sync 落库 chunks 带重叠", () => {
  test(
    "P143-W01 长笔记落库相邻块有重叠（非 800 硬切）",
    async () => {
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      const sentences: string[] = [];
      for (let k = 0; k < 60; k++) {
        sentences.push(`第${k}句：网关超时改为固定重试三次，熔断阈值 SENT${k} 保持不变。`);
      }
      const rel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "长笔记分块",
        body: sentences.join("\n"),
        createdBy: "cli:test",
      });
      const conn = await openPglite(repoRoot);
      try {
        const rows = await conn.db.query<{ text: string }>(
          `SELECT text FROM chunks WHERE path = $1 ORDER BY chunk_index`,
          [rel],
        );
        expect(rows.rows.length).toBeGreaterThan(1);
        const first = String(rows.rows[0]!.text);
        const second = String(rows.rows[1]!.text);
        // 新切分：第二块开头 30 字落在第一块内（overlap）；800 硬切则不在
        expect(first.includes(second.slice(0, 30))).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
