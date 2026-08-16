import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
  hybridQuery,
} from "../src/index.ts";

const T = { timeout: 120_000 };

interface ZhCapture {
  title: string;
  body: string;
  type?: string;
}

interface ZhQueryCase {
  id: string;
  captures: ZhCapture[];
  query: string;
  expect_path_substr: string;
  top_k: number;
}

function hitMatchesExpect(
  hit: { path: string; title: string },
  expectSubstr: string,
): boolean {
  return hit.path.includes(expectSubstr) || hit.title.includes(expectSubstr);
}

describe("P2.1a 中文检索门禁", () => {
  test(
    "P21a-04 中文 fixture top_k 命中率 ≥ 10/12",
    async () => {
      const fixturePath = join(import.meta.dir, "fixtures", "zh_queries.json");
      const raw = await readFile(fixturePath, "utf8");
      const cases = JSON.parse(raw) as ZhQueryCase[];

      expect(cases.length).toBeGreaterThanOrEqual(12);

      const dir = await mkdtemp(join(tmpdir(), "dfmem-p21a-zh-"));
      const repoRoot = await initMemoryRepo(dir, {
        brain: "default",
        source: "default",
        force: false,
      });
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      expect(cfg.embedding.provider).toBe("openai");

      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      for (const c of cases) {
        for (const cap of c.captures) {
          await captureNode(repoRoot, pack, queue, {
            brainId: "default",
            sourceId: "default",
            schemaType: cap.type ?? "decision",
            title: cap.title,
            body: cap.body,
            createdBy: "cli:test",
          });
        }
      }

      const conn = await openPglite(repoRoot);
      let hits = 0;
      const misses: string[] = [];
      try {
        for (const c of cases) {
          const results = await hybridQuery(conn.db, {
            brainId: "default",
            query: c.query,
            limit: c.top_k,
            mode: "conservative",
            embedder: null,
            repoRoot,
          });
          const matched = results.some((h) => hitMatchesExpect(h, c.expect_path_substr));
          if (matched) {
            hits += 1;
          } else {
            misses.push(
              `${c.id} query="${c.query}" expect="${c.expect_path_substr}" got=${results.map((r) => r.title).join("|") || "(empty)"}`,
            );
          }
        }
      } finally {
        await conn.close();
      }

      if (misses.length > 0) {
        console.log(`中文门禁: ${hits}/${cases.length} 命中; 未命中: ${misses.join("; ")}`);
      }
      expect(hits).toBeGreaterThanOrEqual(10);
    },
    T,
  );
});
