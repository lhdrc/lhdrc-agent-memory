/**
 * P5.3 检索增强：tokenmax 扩写 / alias / entity / title-phrase / hotness / rerank / prefilter
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQueryDetailed,
  createEntityRegistry,
  heuristicExpand,
  DEFAULT_SEARCH_CONFIG,
  type SearchConfig,
  type QueryHit,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function patchMemoryYml(patch: Record<string, unknown>): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  const raw = await readFile(path, "utf8");
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && data[k] && typeof data[k] === "object") {
      data[k] = { ...(data[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      data[k] = v;
    }
  }
  await writeFile(path, stringifyYaml(data), "utf8");
}

async function capture(
  title: string,
  body: string,
  extra?: { schemaType?: string; aliases?: string[] },
) {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType: extra?.schemaType ?? "note",
    title,
    body,
    aliases: extra?.aliases,
    createdBy: "cli:test",
  });
}

async function search(
  q: string,
  opts?: { mode?: "conservative" | "balanced" | "tokenmax"; search?: SearchConfig; rerankFn?: HybridRerank },
) {
  const cfg = await loadRepoConfig(repoRoot);
  const conn = await openPglite(repoRoot);
  try {
    return await hybridQueryDetailed(conn.db, {
      brainId: "default",
      query: q,
      mode: opts?.mode ?? "tokenmax",
      repoRoot,
      explain: true,
      skipCache: true,
      search: opts?.search ?? cfg.search,
      rerankFn: opts?.rerankFn,
    });
  } finally {
    await conn.close();
  }
}

type HybridRerank = (query: string, hits: QueryHit[]) => QueryHit[] | Promise<QueryHit[]>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p53-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P5.3 retrieval advanced", () => {
  test("heuristicExpand 原查询 + 至少一条变体", () => {
    const qs = heuristicExpand("重试", 2);
    expect(qs[0]).toBe("重试");
    expect(qs.length).toBeGreaterThanOrEqual(2);
  });

  test(
    "P53-01/02: tokenmax llm=off explain.queries >= 2",
    async () => {
      await capture("重试策略", "网关超时改为固定重试 3 次。");
      const { explain } = await search("重试", { mode: "tokenmax" });
      expect(explain?.mode).toBe("tokenmax");
      expect(explain?.queries?.length).toBeGreaterThanOrEqual(2);
    },
    T,
  );

  test(
    "P53-03: alias hop 按别名召回",
    async () => {
      const path = await capture("正式网关名称", "正文不出现该别名。", { aliases: ["小名"] });
      const { hits, explain } = await search("小名", { mode: "balanced" });
      expect(hits.some((h) => h.path === path)).toBe(true);
      expect(explain?.alias_hits && explain.alias_hits.length >= 0).toBe(true);
    },
    T,
  );

  test(
    "P53-04: entity boost 提到实体的文档分更高",
    async () => {
      const queue = await makeQueue();
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alicepay", title: "AlicePay", createdBy: "cli:test" });
      const related = await capture("接入 AlicePay", "我们决定接入 AlicePay 支付网关。");
      const other = await capture("天气笔记", "今天天气很好与支付无关。");
      const { hits, explain } = await search("AlicePay", { mode: "balanced" });
      const rel = hits.find((h) => h.path === related);
      const oth = hits.find((h) => h.path === other);
      expect(rel).toBeDefined();
      if (oth) expect(rel!.score).toBeGreaterThan(oth.score);
      expect(explain?.entity_boosts?.some((e) => e.path === related)).toBe(true);
    },
    T,
  );

  test(
    "P53-05: title-phrase 连续短语",
    async () => {
      await capture("支付回调处理", "处理网关异步通知。");
      const { explain } = await search("支付回调", { mode: "balanced" });
      expect(explain?.title_phrase).toBe(true);
    },
    T,
  );

  test(
    "P53-06: hotness 新文更靠前；关闭后名次可变化",
    async () => {
      const oldPath = await capture("热度测试-a", "相同主题热度测试正文重试策略。");
      const newPath = await capture("热度测试-z", "相同主题热度测试正文重试策略。");
      const conn = await openPglite(repoRoot);
      try {
        await conn.db.query(`UPDATE pages SET updated_at = $1 WHERE path = $2`, [
          new Date(Date.now() - 60 * 86_400_000).toISOString(),
          oldPath,
        ]);
      } finally {
        await conn.close();
      }
      const onCfg: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        hotness: { enabled: true, half_life_days: 30 },
      };
      const offCfg: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        hotness: { enabled: false, half_life_days: 30 },
      };
      const on = await search("热度测试", { mode: "balanced", search: onCfg });
      const off = await search("热度测试", { mode: "balanced", search: offCfg });
      expect(on.explain?.hotness).toBe(true);
      expect(off.explain?.hotness).toBe(false);
      const scoreOf = (hits: { path: string; score: number }[], p: string) =>
        hits.find((h) => h.path === p)?.score ?? 0;
      const onGap = scoreOf(on.hits, newPath) - scoreOf(on.hits, oldPath);
      const offGap = scoreOf(off.hits, newPath) - scoreOf(off.hits, oldPath);
      const onIdxNew = on.hits.findIndex((h) => h.path === newPath);
      const onIdxOld = on.hits.findIndex((h) => h.path === oldPath);
      expect(onIdxNew).toBeGreaterThanOrEqual(0);
      expect(onIdxNew).toBeLessThan(onIdxOld);
      expect(onGap).toBeGreaterThan(offGap);
    },
    T,
  );

  test(
    "P53-07: rerank local 可改变 top1 或记录 scores",
    async () => {
      await patchMemoryYml({
        search: { tokenmax: { rerank: "local", expand: true, expand_n: 2, rerank_top_n: 20 } },
      });
      const bag = await capture(
        "其他主题文档",
        `${"支付 ".repeat(40)}${"回调 ".repeat(40)}大量词袋重叠。`,
      );
      const phrase = await capture("支付回调", "短正文。");
      const cfg = await loadRepoConfig(repoRoot);
      const { hits, explain } = await search("支付回调", { mode: "tokenmax", search: cfg.search });
      expect(explain?.rerank).toBe("local");
      const topChanged = hits[0]?.path === phrase;
      const hasScores = (explain?.rerank_scores?.length ?? 0) > 0;
      expect(topChanged || hasScores).toBe(true);
      expect(hits.some((h) => h.path === bag || h.path === phrase)).toBe(true);
    },
    T,
  );

  test(
    "P53-08: rerank off 可跑；throw → skipped",
    async () => {
      const offCfg: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        tokenmax: { ...DEFAULT_SEARCH_CONFIG.tokenmax, rerank: "off" },
      };
      await capture("重试", "固定三次。");
      const off = await search("重试", { mode: "tokenmax", search: offCfg });
      expect(off.explain?.rerank).toBe("off");
      expect(off.hits.length).toBeGreaterThan(0);

      const boom = await search("重试", {
        mode: "tokenmax",
        search: { ...offCfg, tokenmax: { ...offCfg.tokenmax, rerank: "local" } },
        rerankFn: () => {
          throw new Error("boom");
        },
      });
      expect(boom.explain?.rerank).toBe("skipped");
      expect(boom.hits.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P53-09: directory_prefilter explain 含目录",
    async () => {
      await patchMemoryYml({ search: { directory_prefilter: true } });
      await capture("预筛决策", "预筛关键词出现在决策里。", { schemaType: "decision" });
      await capture("预筛笔记", "预筛关键词出现在笔记里。", { schemaType: "note" });
      const cfg = await loadRepoConfig(repoRoot);
      const { explain, hits } = await search("预筛关键词", { mode: "balanced", search: cfg.search });
      expect(explain?.directory_prefilter).toBeTruthy();
      expect((explain?.directory_prefilter as { dirs: unknown[] })?.dirs?.length).toBeGreaterThan(0);
      expect(hits.length).toBeGreaterThan(0);
    },
    T,
  );
});
