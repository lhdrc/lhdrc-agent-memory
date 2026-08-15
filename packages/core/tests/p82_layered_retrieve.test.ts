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
  hybridQuery,
  hybridQueryDetailed,
  graphArmDetailed,
  writeSkill,
  writeExperience,
  bm25Query,
  appendPageFilters,
  ErrorCodes,
} from "../src/index.ts";

const OVERVIEW_SIDECAR_SUFFIX = ".overview.md";
const T = { timeout: 60_000 };
const SIDEcar_MARKER = "UNIQUE_SIDEcar_XYZ";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function seedIndexedPage(
  db: Awaited<ReturnType<typeof openPglite>>["db"],
  path: string,
  body: string,
): Promise<void> {
  const now = new Date().toISOString();
  const title = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  await db.query(
    `INSERT INTO pages (
       path, brain_id, source_id, schema_type, title, status,
       aliases_json, frontmatter_json, body_text, content_hash, updated_at,
       fts_title, fts_body, title_ngrams, body_ngrams
     ) VALUES ($1, 'default', 'default', 'note', $2, 'active', '[]', '{}', $3, 'test', $4, $2, $3, '', '')`,
    [path, title, body, now],
  );
}

async function capture(title: string, body: string, schemaType = "note") {
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
  opts?: {
    schemaType?: string;
    excludeSchemaTypes?: string[];
    excludeSidecars?: boolean;
    explain?: boolean;
    limit?: number;
  },
) {
  const conn = await openPglite(repoRoot);
  try {
    if (opts?.explain) {
      return await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: q,
        limit: opts?.limit ?? 10,
        repoRoot,
        skipCache: true,
        explain: true,
        schemaType: opts?.schemaType,
        excludeSchemaTypes: opts?.excludeSchemaTypes,
        excludeSidecars: opts?.excludeSidecars,
      });
    }
    return await hybridQuery(conn.db, {
      brainId: "default",
      query: q,
      limit: opts?.limit ?? 10,
      repoRoot,
      skipCache: true,
      schemaType: opts?.schemaType,
      excludeSchemaTypes: opts?.excludeSchemaTypes,
      excludeSidecars: opts?.excludeSidecars,
    });
  } finally {
    await conn.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p82-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P8.2 layered retrieve filters", () => {
  test(
    "P82-01 excludeSchemaTypes 排除 skill 路径",
    async () => {
      const queue = await makeQueue();
      await capture("重试笔记", "网关重试策略 note 正文。");
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "retry-skill",
        title: "重试技能",
        trigger: "重试",
        procedure: "固定 3 次",
        boundary: "网关",
        verification: "单测",
        status: "active",
      });

      const hits = (await hybrid("重试", { excludeSchemaTypes: ["skill"] })) as Awaited<
        ReturnType<typeof hybridQuery>
      >;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => !h.path.includes("/skills/"))).toBe(true);
    },
    T,
  );

  test(
    "P82-02 schemaType 与 excludeSchemaTypes 互斥 → E_USAGE",
    async () => {
      const conn = await openPglite(repoRoot);
      try {
        await expect(
          hybridQuery(conn.db, {
            brainId: "default",
            query: "重试",
            schemaType: "note",
            excludeSchemaTypes: ["skill"],
          }),
        ).rejects.toMatchObject({ code: ErrorCodes.USAGE });
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P82-03 excludeSidecars 排除 overview 侧车",
    async () => {
      const l0Path = "brains/default/sources/default/notes/sidecar-l0.md";
      const overviewPath = "brains/default/sources/default/notes/sidecar-l0.overview.md";
      const conn = await openPglite(repoRoot);
      try {
        await seedIndexedPage(conn.db, l0Path, "支付网关超时重试策略正文。");
        await seedIndexedPage(conn.db, overviewPath, `${SIDEcar_MARKER} only in sidecar.`);

        const { clauses } = appendPageFilters({ excludeSidecars: true }, 1);
        expect(clauses.some((c) => c.includes("overview.md"))).toBe(true);
        expect(clauses.some((c) => c.includes("abstract.md"))).toBe(true);

        const withSidecars = await bm25Query(conn.db, {
          brainId: "default",
          query: SIDEcar_MARKER,
        });
        expect(withSidecars.some((h) => h.path === overviewPath)).toBe(true);

        const withoutSidecars = await bm25Query(conn.db, {
          brainId: "default",
          query: SIDEcar_MARKER,
          excludeSidecars: true,
        });
        expect(withoutSidecars.some((h) => h.path.endsWith(OVERVIEW_SIDECAR_SUFFIX))).toBe(false);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P82-04 图臂 schemaType=experience 不返回非 experience 路径",
    async () => {
      await capture("支付决策笔记", "与 [[支付]] 对齐网关超时重试。");
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时经验",
        trigger: "支付网关超时",
        procedure: "固定重试 3 次",
        boundary: "同步支付",
        sourcePaths: ["sources/default/x.md"],
        etaScore: 0.8,
        support: 2,
      });

      const conn = await openPglite(repoRoot);
      try {
        const graph = await graphArmDetailed(conn.db, {
          brainId: "default",
          query: "谁提到了支付",
          schemaType: "experience",
          limit: 20,
        });
        for (const h of graph.hits) {
          expect(h.path).toContain("/experiences/");
        }

        const { hits, explain } = (await hybrid("支付", {
          schemaType: "experience",
          explain: true,
        })) as Awaited<ReturnType<typeof hybridQueryDetailed>>;
        expect(hits.every((h) => h.path.includes("/experiences/"))).toBe(true);
        if (explain?.arms.graph.length) {
          expect(explain.arms.graph.every((g) => g.path.includes("/experiences/"))).toBe(true);
        }
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
