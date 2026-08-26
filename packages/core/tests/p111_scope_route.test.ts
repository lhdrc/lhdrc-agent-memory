/**
 * P11.1 意图范围选择：窄搜 → 不足再扩
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  writeExperience,
  openPglite,
  hybridQueryDetailed,
  thinkQuery,
  classifyIntent,
  scopePrefixForIntent,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const Q_EXP = "踩坑 重试";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p111-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return { repoRoot, pack, queue, search: cfg.search };
}

async function seedBoth(repoRoot: string, pack: Awaited<ReturnType<typeof loadPack>>, queue: WriteQueue) {
  const notePath = await captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: "note",
    title: "重试策略踩坑笔记",
    body: "笔记侧也写了固定三次重试，避免和无经验标题撞车。",
    createdBy: "cli:test",
  });
  const expPath = await writeExperience(repoRoot, pack, queue, {
    brainId: "default",
    title: "重试策略踩坑经验",
    trigger: "踩坑 重试超时",
    procedure: "固定三次重试",
    boundary: "同步调用",
    sourcePaths: [notePath.replace(/\\/g, "/")],
  });
  return { notePath, expPath };
}

async function seedNoteOnly(repoRoot: string, pack: Awaited<ReturnType<typeof loadPack>>, queue: WriteQueue) {
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: "note",
    title: "重试策略踩坑笔记",
    body: "只有 notes 里有这条重试踩坑。",
    createdBy: "cli:test",
  });
}

async function search(
  repoRoot: string,
  q: string,
  extra: { scopeFirst?: boolean; explain?: boolean; limit?: number; search?: Awaited<ReturnType<typeof loadRepoConfig>>["search"] } = {},
) {
  const conn = await openPglite(repoRoot);
  try {
    return await hybridQueryDetailed(conn.db, {
      brainId: "default",
      query: q,
      repoRoot,
      skipCache: true,
      explain: extra.explain ?? true,
      limit: extra.limit ?? 5,
      scopeFirst: extra.scopeFirst,
      search: extra.search,
    });
  } finally {
    await conn.close();
  }
}

describe("P11.1 scope route", () => {
  test("P111 intent 映射", () => {
    expect(classifyIntent(Q_EXP)).toBe("experience");
    expect(scopePrefixForIntent("experience").label).toBe("experiences/");
    expect(scopePrefixForIntent("relation").kind).toBe("off");
    expect(classifyIntent("谁负责支付")).toBe("relation");
  });

  test(
    "P111-01 scope_first + experience → top-1 在 experiences/ 且 expand:none",
    async () => {
      const { repoRoot, pack, queue, search: searchCfg } = await setup();
      await seedBoth(repoRoot, pack, queue);
      const { hits, explain } = await search(repoRoot, Q_EXP, {
        scopeFirst: true,
        limit: 1,
        search: { ...searchCfg, scope_first: true },
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.path.replace(/\\/g, "/")).toContain("/experiences/");
      expect(explain?.query_plan?.some((s) => s === "expand:none")).toBe(true);
      expect(explain?.query_plan?.some((s) => s === "scope:experiences/")).toBe(true);
    },
    T,
  );

  test(
    "P111-02 experiences 抽空 → expand:global 命中 notes",
    async () => {
      const { repoRoot, pack, queue, search: searchCfg } = await setup();
      const notePath = await seedNoteOnly(repoRoot, pack, queue);
      const { hits, explain } = await search(repoRoot, Q_EXP, {
        scopeFirst: true,
        search: { ...searchCfg, scope_first: true },
      });
      expect(explain?.query_plan?.some((s) => s === "expand:global")).toBe(true);
      expect(hits.some((h) => h.path.replace(/\\/g, "/") === notePath.replace(/\\/g, "/"))).toBe(true);
    },
    T,
  );

  test(
    "P111-03 scope_first:false 与未开范围选择终榜一致",
    async () => {
      const { repoRoot, pack, queue, search: searchCfg } = await setup();
      await seedBoth(repoRoot, pack, queue);
      const a = await search(repoRoot, Q_EXP, { scopeFirst: false, search: { ...searchCfg, scope_first: false } });
      const b = await search(repoRoot, Q_EXP, { search: { ...searchCfg, scope_first: false } });
      expect(a.hits.map((h) => h.path)).toEqual(b.hits.map((h) => h.path));
    },
    T,
  );

  test(
    "P111-04 relation 不写目录先验",
    async () => {
      const { repoRoot, pack, queue, search: searchCfg } = await setup();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "支付网关",
        body: "谁负责支付由网关组决定。",
        createdBy: "cli:test",
      });
      const { explain } = await search(repoRoot, "谁负责支付", {
        scopeFirst: true,
        search: { ...searchCfg, scope_first: true },
      });
      expect(explain?.query_plan?.some((s) => s === "scope:off")).toBe(true);
      expect(explain?.query_plan?.some((s) => s.startsWith("scope:experiences"))).toBe(false);
    },
    T,
  );

  test(
    "P111-05 thinkQuery 忽略 yml 关闭，先搜 experiences",
    async () => {
      const { repoRoot, pack, queue } = await setup();
      await seedBoth(repoRoot, pack, queue);
      const conn = await openPglite(repoRoot);
      try {
        const r = await thinkQuery(conn.db, {
          brainId: "default",
          query: Q_EXP,
          repoRoot,
          limit: 8,
        });
        expect(r.experiences.length).toBeGreaterThan(0);
        expect(r.experiences[0]!.path.replace(/\\/g, "/")).toContain("/experiences/");
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P111-06 explain 含 intent: 与 expand:；init 模板含 scope_first: false",
    async () => {
      const { repoRoot, pack, queue, search: searchCfg } = await setup();
      await seedBoth(repoRoot, pack, queue);
      const { explain } = await search(repoRoot, Q_EXP, {
        scopeFirst: true,
        limit: 1,
        search: { ...searchCfg, scope_first: true },
      });
      expect(explain?.query_plan?.some((s) => s.startsWith("intent:"))).toBe(true);
      expect(explain?.query_plan?.some((s) => s.startsWith("expand:"))).toBe(true);
      const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
      expect(yml).toContain("scope_first: false");
    },
    T,
  );
});
