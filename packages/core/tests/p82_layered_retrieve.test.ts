import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  annotateHits,
  fuseHybridArms,
  layerTieBreakKey,
  TIE_BREAK_EPS,
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

describe("P8.2 hit annotation", () => {
  test(
    "P82-05 experience 标注 trigger / eta_score / source_paths",
    async () => {
      const trigger = "P82TRIGGER_网关超时标注";
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时经验标注",
        trigger,
        procedure: "固定重试 3 次",
        boundary: "同步支付",
        sourcePaths: ["sources/default/notes/p82-src.md"],
        etaScore: 0.77,
        support: 3,
      });

      const hits = (await hybrid(trigger, { schemaType: "experience" })) as Awaited<
        ReturnType<typeof hybridQuery>
      >;
      const hit = hits.find((h) => h.path.includes("/experiences/"));
      expect(hit).toBeDefined();
      expect(hit!.schema_type).toBe("experience");
      expect(hit!.eta_score).toBe(0.77);
      expect(hit!.support).toBe(3);
      expect(hit!.source_paths).toEqual(["brains/default/sources/default/notes/p82-src.md"]);
      expect(hit!.snippet).toContain(trigger);
    },
    T,
  );

  test(
    "P82-06 标注缺字段或读失败 fail-open",
    async () => {
      const missingPath = "brains/default/experiences/p82-missing.md";
      const missingHits = await annotateHits(repoRoot, [
        { path: missingPath, title: "gone", score: 0.42, snippet: "body snippet", evidence: ["keyword"] },
      ]);
      expect(missingHits).toHaveLength(1);
      expect(missingHits[0]!.path).toBe(missingPath);
      expect(missingHits[0]!.score).toBe(0.42);
      expect(missingHits[0]!.snippet).toBe("body snippet");
      expect(missingHits[0]!.eta_score).toBeUndefined();
      expect(missingHits[0]!.support).toBeUndefined();
      expect(missingHits[0]!.source_paths).toBeUndefined();

      const bareRel = "brains/default/experiences/p82-bare.md";
      await mkdir(join(repoRoot, dirname(bareRel)), { recursive: true });
      await writeFile(
        join(repoRoot, bareRel),
        "---\ntitle: bare\nschema_type: experience\n---\n\n只有正文没有 trigger。\n",
        "utf8",
      );
      const bareHits = await annotateHits(repoRoot, [
        { path: bareRel, title: "bare", score: 0.31, snippet: "只有正文没有 trigger。", evidence: [] },
      ]);
      expect(bareHits[0]!.path).toBe(bareRel);
      expect(bareHits[0]!.score).toBe(0.31);
      expect(bareHits[0]!.eta_score).toBeUndefined();
      expect(bareHits[0]!.support).toBeUndefined();
      expect(bareHits[0]!.source_paths).toBeUndefined();
      expect(bareHits[0]!.snippet).toBe("只有正文没有 trigger。");

      const trigger = "P82TRIGGER_读失败仍保留";
      const queue = await makeQueue();
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "将被删除的经验",
        trigger,
        procedure: "x",
        boundary: "y",
        sourcePaths: ["sources/default/x.md"],
        etaScore: 0.9,
        support: 2,
      });
      await unlink(join(repoRoot, expPath));
      const hits = (await hybrid(trigger, { schemaType: "experience" })) as Awaited<
        ReturnType<typeof hybridQuery>
      >;
      const hit = hits.find((h) => h.path === expPath);
      expect(hit).toBeDefined();
      expect(hit!.score).toBeGreaterThan(0);
      expect(hit!.eta_score).toBeUndefined();
      expect(hit!.source_paths).toBeUndefined();
    },
    T,
  );
});

describe("P8.2 tie-break (P82-08 optional)", () => {
  const WEIGHTS_ONE = {
    wKw: 1,
    wSem: 0,
    wGraph: 0,
    wTitle: 0,
    wEntity: 0,
  };

  function fuseTwo(
    bm25: Array<{ path: string }>,
    semantic: Array<{ path: string }>,
    weights = WEIGHTS_ONE,
  ) {
    return fuseHybridArms(
      bm25.map((h) => ({ path: h.path, score: 0.9 })),
      semantic.map((h) => ({ path: h.path, score: 0.9 })),
      {
        mode: "balanced",
        query: "重试",
        titles: new Map<string, string>(),
        limit: 10,
        semanticAvailable: semantic.length > 0,
        graphHits: [], // 显式 weights 需走含图融合公式
        weights,
      },
    );
  }

  test("layerTieBreakKey: skill < experience < L0 < other", () => {
    const skill = layerTieBreakKey("brains/default/skills/retry/SKILL.md");
    const exp = layerTieBreakKey("brains/default/experiences/x.md");
    const note = layerTieBreakKey("brains/default/sources/default/notes/x.md");
    const entity = layerTieBreakKey("brains/default/entities/alice.md");
    expect(skill).toBeLessThan(exp);
    expect(exp).toBeLessThan(note);
    expect(note).toBeLessThan(entity);
  });

  test(
    "分差 <0.01 并列时 experience 排在 note 前（path 字母序相反时仍生效）",
    () => {
      // 两个 hit 同分（bm25/semantic 对称）；字母序上 entity 更前，但 tie-break 应让 note 前
      const entity = "brains/default/entities/aaa.md";
      const note = "brains/default/sources/aaa/notes/zzz.md";
      expect(entity.localeCompare(note)).toBeLessThan(0); // 无 tie-break 时 entity 本应在前
      const fused = fuseTwo(
        [{ path: entity }, { path: note }],
        [{ path: note }, { path: entity }],
      );
      expect(fused.length).toBe(2);
      expect(Math.abs(fused[0]!.score - fused[1]!.score)).toBeLessThan(TIE_BREAK_EPS);
      expect(fused[0]!.path).toBe(note); // L0 优先于其它
    },
    T,
  );

  test(
    "分差 >=0.05 时相关度更高者仍在前（tie-break 不压过 RRF）",
    () => {
      const entity = "brains/default/entities/aaa.md";
      const note = "brains/default/sources/aaa/notes/zzz.md";
      // entity 标题命中 query → tp=0.7 权重拉高，分差远超 ε；
      // 即使 note 是 L0（tie-break 本应更前）也不得反超。
      const fused = fuseHybridArms(
        [{ path: entity }, { path: note }],
        [],
        {
          mode: "balanced",
          query: "重试",
          titles: new Map([[entity, "重试"]]),
          limit: 10,
          semanticAvailable: false,
          graphHits: [],
          weights: { wKw: 1, wSem: 0, wGraph: 0, wTitle: 1, wEntity: 0 },
        },
      );
      expect(fused.length).toBe(2);
      expect(fused[0]!.path).toBe(entity);
      expect(fused[0]!.score - fused[1]!.score).toBeGreaterThanOrEqual(0.05);
    },
    T,
  );
});
