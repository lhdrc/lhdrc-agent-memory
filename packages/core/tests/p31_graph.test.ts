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
  parseRelationalQuery,
  graphArm,
  knobsHash,
  getSearchCache,
  setSearchCache,
  applyGraphSignalsPure,
  fuseHybridArms,
  WEIGHTS_BALANCED_GRAPH,
  RRF_K,
  type SearchKnobs,
  type FusedHit,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 30_000 };

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
  dir = await mkdtemp(join(tmpdir(), "dfmem-p31-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P3.1 links sync + graph + cache + signals", () => {
  test(
    "P31-01 正文 [[alice]] 同步后 links 有 mentions",
    async () => {
      const rel = await capture("支付决策", "与 [[alice]] 对齐重试策略。");
      const conn = await openPglite(repoRoot);
      try {
        const r = await conn.db.query<{ to_ref: string; type: string; source: string }>(
          `SELECT to_ref, type, source FROM links WHERE from_path = $1`,
          [rel],
        );
        expect(r.rows.some((row) => row.to_ref === "alice" && row.type === "mentions")).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P31-03 graph-query 解析失败不导致 query 崩溃",
    async () => {
      await capture("普通笔记", "没有任何关系模板的正文内容。");
      expect(parseRelationalQuery("随便查一下重试")).toBeNull();
      const conn = await openPglite(repoRoot);
      try {
        const arm = await graphArm(conn.db, { brainId: "default", query: "随便查一下重试" });
        expect(arm).toEqual([]);
        const hits = await hybridQuery(conn.db, {
          brainId: "default",
          query: "随便查一下重试",
          repoRoot,
          skipCache: true,
        });
        expect(Array.isArray(hits)).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P31-04 改 search.mode 后旧 cache 不命中（knobs_hash）",
    async () => {
      const knobsA: SearchKnobs = {
        mode: "balanced",
        brainId: "default",
        intent: "general",
        weightsKey: "w1",
        limit: 10,
        semanticAvailable: false,
      };
      const knobsB: SearchKnobs = { ...knobsA, mode: "conservative" };
      expect(knobsHash(knobsA)).not.toBe(knobsHash(knobsB));

      const conn = await openPglite(repoRoot);
      try {
        await setSearchCache(conn.db, "重试", knobsA, [
          { path: "a.md", title: "a", score: 1, snippet: "", evidence: [] },
        ]);
        const hit = await getSearchCache(conn.db, "重试", knobsA);
        expect(hit).not.toBeNull();
        const miss = await getSearchCache(conn.db, "重试", knobsB);
        expect(miss).toBeNull();
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("P31-05 hub 信号改变排序（构造夹具）", () => {
    const mk = (path: string, score: number): FusedHit => ({
      path,
      score,
      rrfBm25: 0,
      rrfSemantic: 0,
      rrfGraph: 0,
      titlePathBoost: 0,
      entityBoost: 0,
      evidence: [],
    });
    const pHub = "brains/default/sources/a/hub.md";
    const p1 = "brains/default/sources/a/n1.md";
    const p2 = "brains/default/sources/a/n2.md";
    const pLone = "brains/default/sources/b/lone.md";
    const hits = [mk(pLone, 1.0), mk(pHub, 0.99), mk(p1, 0.5), mk(p2, 0.5)];
    const adjacency = new Map<string, Set<string>>([
      [pHub, new Set([p1, p2])],
      [p1, new Set([pHub])],
      [p2, new Set([pHub])],
    ]);
    const { hits: out } = applyGraphSignalsPure(hits, {
      adjacency,
      inboundSources: new Map(),
      topK: 4,
    });
    // hub 乘 1.05 → 0.99*1.05 = 1.0395 > lone 1.0
    expect(out[0]!.path).toBe(pHub);
    expect(out[0]!.evidence).toContain("signal:hub");
  });

  test("含 graph 的融合公式单测夹具", () => {
    const titles = new Map([
      ["p1", "支付"],
      ["p2", "其他"],
    ]);
    const out = fuseHybridArms([{ path: "p1" }, { path: "p2" }], [], {
      mode: "balanced",
      query: "支付",
      titles,
      limit: 5,
      semanticAvailable: false,
      graphHits: [{ path: "p1" }],
      intent: "relation",
      weights: WEIGHTS_BALANCED_GRAPH,
    });
    expect(out[0]!.path).toBe("p1");
    expect(out[0]!.rrfGraph).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(out[0]!.evidence).toContain("graph");
  });

  test(
    "query --explain 稳定 JSON schema（hybridQueryDetailed）",
    async () => {
      await capture("重试策略", "改为固定 3 次。");
      const conn = await openPglite(repoRoot);
      try {
        const { hits, explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试",
          repoRoot,
          explain: true,
          skipCache: true,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(explain).toBeDefined();
        expect(explain!.intent).toBeDefined();
        expect(explain!.mode).toBeDefined();
        expect(typeof explain!.cacheHit).toBe("boolean");
        expect(typeof explain!.knobsHash).toBe("string");
        expect(explain!.arms).toHaveProperty("bm25");
        expect(explain!.arms).toHaveProperty("semantic");
        expect(explain!.arms).toHaveProperty("graph");
        expect(explain!.signals).toHaveProperty("hub");
        expect(explain!.weightsKey).toBeDefined();
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "links 可从文件 rebuild",
    async () => {
      const rel = await capture("图谱重建", "提到 [[alice]] 与 @bob");
      const { rebuildIndex } = await import("../src/index.ts");
      await rebuildIndex(repoRoot, "default");
      const conn = await openPglite(repoRoot);
      try {
        const r = await conn.db.query<{ to_ref: string }>(
          `SELECT to_ref FROM links WHERE from_path = $1`,
          [rel],
        );
        const tos = r.rows.map((x) => x.to_ref);
        expect(tos).toContain("alice");
        expect(tos).toContain("bob");
      } finally {
        await conn.close();
      }
    },
    T,
  );
});
