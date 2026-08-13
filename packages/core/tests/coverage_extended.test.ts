/**
 * 扩展覆盖：dream 各 phase、graph 次级信号、OpenAI embed、tokenmax、
 * D18 batch flush、revert supersede、import 目录、cost cap、无 git flush 等。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  runDream,
  refineSource,
  writeExperience,
  revertMemoryDiff,
  listMemoryDiffs,
  importPath,
  readNode,
  openPglite,
  hybridQueryDetailed,
  fuseHybridArms,
  applyGraphSignalsPure,
  SIGNAL_CROSS_SOURCE,
  SIGNAL_DIVERSIFY,
  shouldBatchFlush,
  gitLog,
  flushRepoLedger,
  gitIsRepo,
  createEmbeddingProvider,
  OpenAIEmbedding,
  withCostAccounting,
  readCostConfig,
  appendCostEntry,
  readCostLog,
  wouldExceedCap,
  serializeFrontmatter,
  parseFrontmatter,
  sha256Hex,
  MemoryError,
  ErrorCodes,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type FusedHit,
  type RepoConfig,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

class FakeLLM implements LLMProvider {
  readonly id = "fake";
  constructor(
    private decision: DistillDecision,
    private exp?: Partial<ExperienceResult>,
  ) {}

  async judgeDistill(): Promise<DistillDecision> {
    return this.decision;
  }

  async generateAbstract(content: string): Promise<string> {
    return content.slice(0, 100);
  }

  async generateOverview(children: string[]): Promise<string> {
    return children.join("\n");
  }

  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
    return {
      title: this.exp?.title ?? ctx.title,
      trigger: this.exp?.trigger ?? "timeout",
      procedure: this.exp?.procedure ?? "retry 3 times",
      boundary: this.exp?.boundary ?? "idempotent",
      body: this.exp?.body ?? ctx.candidate,
    };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-ext-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("扩展覆盖", () => {
  test(
    "dream phase 1 lint 检测缺 title；fix 补全",
    async () => {
      const rel = "brains/default/sources/default/issues/general/notes/no-title.md";
      const abs = join(repoRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        serializeFrontmatter(
          {
            schema_type: "note",
            source: "default",
            path: "sources/default/issues/general/notes/no-title.md",
            created_by: "test",
            status: "active",
          },
          "body without title",
        ),
        "utf8",
      );

      const queue = await makeQueue();
      const r1 = await runDream(repoRoot, { brainId: "default", queue, phases: [1] });
      expect(r1.phases[0]!.name).toBe("lint");
      expect(r1.phases[0]!.details!.issues).toBeGreaterThan(0);

      const r2 = await runDream(repoRoot, { brainId: "default", queue, phases: [1], fix: true });
      expect(r2.phases[0]!.details!.fixed).toBeGreaterThan(0);
      const raw = await readFile(abs, "utf8");
      const { data } = parseFrontmatter(raw);
      expect(data.title).toBe("no-title");
    },
    T,
  );

  test(
    "dream phase 3 distill-run 写入 experience",
    async () => {
      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "dream蒸馏",
        body: "网关超时固定重试 3 次。",
        createdBy: "test",
      });
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "dream" });
      const r = await runDream(repoRoot, { brainId: "default", queue, phases: [3], llm });
      expect(r.phases[0]!.skipped).not.toBe(true);
      expect(Number(r.phases[0]!.details!.written)).toBeGreaterThan(0);
      const expDir = join(repoRoot, "brains/default/experiences");
      expect(existsSync(expDir)).toBe(true);
    },
    T,
  );

  test(
    "dream phase 4 contradictions 写入 findings",
    async () => {
      const rel = "brains/default/sources/default/issues/general/decisions/contra.md";
      const abs = join(repoRoot, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(
        abs,
        serializeFrontmatter(
          {
            title: "冲突事实",
            schema_type: "decision",
            source: "default",
            path: "sources/default/issues/general/decisions/contra.md",
            created_by: "test",
            status: "active",
            facts: [
              { text: "支付超时必须重试三次", event_type: "decision", attributed_to: "a", at: "2026-01-01" },
              { text: "支付超时必须重试", event_type: "requirement", attributed_to: "b", at: "2026-01-01" },
            ],
          },
          "正文",
        ),
        "utf8",
      );

      const queue = await makeQueue();
      const r = await runDream(repoRoot, { brainId: "default", queue, phases: [4] });
      expect(r.phases[0]!.details!.findings).toBeGreaterThan(0);
      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).toContain("可能冲突");
      expect(contra).toContain("contra.md");
    },
    T,
  );

  test("graph signals cross-source ×1.1", () => {
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
    const target = "brains/default/sources/default/issues/general/decisions/hub.md";
    const hits = [mk("brains/default/sources/other/x.md", 1.0), mk(target, 0.9)];
    const { hits: out, signals } = applyGraphSignalsPure(hits, {
      adjacency: new Map(),
      inboundSources: new Map([[target, new Set(["srcA", "srcB"])]]),
      topK: 2,
    });
    const t = out.find((h) => h.path === target)!;
    expect(t.score).toBeCloseTo(0.9 * SIGNAL_CROSS_SOURCE, 5);
    expect(t.evidence).toContain("signal:cross-source");
    expect(signals.crossSource).toContain(target);
  });

  test("graph signals session diversify ×0.95", () => {
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
    const a = "brains/default/sources/default/issues/general/decisions/a.md";
    const b = "brains/default/sources/default/issues/general/decisions/b.md";
    const hits = [mk(a, 1.0), mk(b, 0.8)];
    const { hits: out, signals } = applyGraphSignalsPure(hits, {
      adjacency: new Map(),
      inboundSources: new Map(),
      topK: 2,
    });
    const loser = out.find((h) => h.path === b)!;
    expect(loser.score).toBeCloseTo(0.8 * SIGNAL_DIVERSIFY, 5);
    expect(loser.evidence).toContain("signal:diversify");
    expect(signals.diversified).toContain(b);
  });

  test("OpenAI embedding mock fetch 成功", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      process.env.TEST_OPENAI_KEY = "sk-test";
      const p = createEmbeddingProvider({
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 3,
        openai_api_key_env: "TEST_OPENAI_KEY",
      });
      expect(p.id).toBe("openai");
      const vecs = await p.embed(["hello"]);
      expect(vecs[0]).toHaveLength(3);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.TEST_OPENAI_KEY;
    }
  });

  test("OpenAI embedding 缺 API key → E_USAGE", async () => {
    delete process.env.MISSING_EMBED_KEY;
    const p = new OpenAIEmbedding({
      provider: "openai",
      model: "text-embedding-3-small",
      dims: 3,
      openai_api_key_env: "MISSING_EMBED_KEY",
    });
    await expect(p.embed(["x"])).rejects.toMatchObject({ code: ErrorCodes.USAGE });
  });

  test("tokenmax 融合与 balanced 一致", () => {
    const titles = new Map([
      ["p1", "支付"],
      ["p2", "其他"],
    ]);
    const args = {
      query: "支付",
      titles,
      limit: 5,
      semanticAvailable: true,
      graphHits: [{ path: "p1" }],
      intent: "general" as const,
    };
    const balanced = fuseHybridArms([{ path: "p1" }, { path: "p2" }], [{ path: "p1" }], {
      ...args,
      mode: "balanced",
    });
    const tokenmax = fuseHybridArms([{ path: "p1" }, { path: "p2" }], [{ path: "p1" }], {
      ...args,
      mode: "tokenmax",
    });
    expect(tokenmax.map((h) => h.path)).toEqual(balanced.map((h) => h.path));
    expect(tokenmax[0]!.score).toBeCloseTo(balanced[0]!.score, 8);
  });

  test(
    "hybridQuery tokenmax mode 可查询",
    async () => {
      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "tokenmax测试",
        body: "固定重试策略",
        createdBy: "test",
      });
      const conn = await openPglite(repoRoot);
      try {
        const { hits, explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试",
          repoRoot,
          mode: "tokenmax",
          skipCache: true,
          explain: true,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(explain?.mode).toBe("tokenmax");
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("shouldBatchFlush N 与 T 触发", async () => {
    const cfg = await loadRepoConfig(repoRoot);
    const batchCfg: RepoConfig = {
      ...cfg,
      git: { ...cfg.git, mode: "batch", auto_commit: true, batch_size: 3, batch_interval_ms: 1000 },
    };
    expect(shouldBatchFlush(batchCfg, 3, null, null)).toBe(true);
    expect(shouldBatchFlush(batchCfg, 2, null, null)).toBe(false);
    const old = new Date(Date.now() - 2000).toISOString();
    expect(shouldBatchFlush(batchCfg, 1, null, old)).toBe(true);
    expect(shouldBatchFlush({ ...batchCfg, git: { ...batchCfg.git, mode: "off" } }, 99, null, old)).toBe(
      false,
    );
  });

  test(
    "D18 batch_size=2 两次 capture 自动 flush",
    async () => {
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml = yml.replace(/batch_size:\s*\d+/, "batch_size: 2");
      await writeFile(ymlPath, yml, "utf8");

      const before = await gitLog(repoRoot, 5);
      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "batch1",
        body: "a",
        createdBy: "test",
      });
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "batch2",
        body: "b",
        createdBy: "test",
      });
      const after = await gitLog(repoRoot, 5);
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.some((l) => l.includes("flush"))).toBe(true);
    },
    T,
  );

  test(
    "refine 后 experience 无 overview（L1 未接线）",
    async () => {
      const queue = await makeQueue();
      const rel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "overview缺口",
        body: "测试 overview 字段是否存在。",
        createdBy: "test",
      });
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "ov" });
      const r = await refineSource(repoRoot, { brainId: "default", path: rel, queue, llm });
      const raw = await readFile(join(repoRoot, r.paths![0]!), "utf8");
      expect(raw).toContain("abstract:");
      expect(raw).not.toMatch(/^overview:/m);
    },
    T,
  );

  test(
    "readNode 返回完整文件（--layer 未实现时的默认行为）",
    async () => {
      const queue = await makeQueue();
      const rel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "read测试",
        body: "## Section\n正文内容",
        createdBy: "test",
      });
      const node = await readNode(repoRoot, "default", rel.replace(/^brains\/default\//, ""));
      expect(node.raw).toContain("read测试");
      expect(node.raw).toContain("正文内容");
    },
    T,
  );

  test(
    "revert experience_supersede → active",
    async () => {
      const queue = await makeQueue();
      const sourceRel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "supersede回滚",
        body: "源文件不变。",
        createdBy: "test",
      });
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "旧经验",
        trigger: "t",
        procedure: "p",
        boundary: "b",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expsup01",
      });
      const llm = new FakeLLM({
        candidate: "none",
        item: "delete",
        targetExpId: "expsup01",
        confidence: 0.9,
        rationale: "sup",
      });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });
      const diffs = await listMemoryDiffs(repoRoot, "default", 10);
      const supDiff = diffs.find((d) => d.op === "experience_supersede");
      expect(supDiff).toBeDefined();
      const rev = await revertMemoryDiff(repoRoot, "default", supDiff!.id, queue);
      expect(rev.ok).toBe(true);
      const raw = await readFile(join(repoRoot, rev.path!), "utf8");
      expect(raw).toContain("status: active");
    },
    T,
  );

  test(
    "revert experience_merge → unsupported_op",
    async () => {
      const queue = await makeQueue();
      const sourceRel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "merge回滚",
        body: "merge 暂不支持 revert。",
        createdBy: "test",
      });
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "待合并",
        trigger: "t",
        procedure: "p",
        boundary: "b",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expmer01",
      });
      const llm = new FakeLLM({
        candidate: "none",
        item: "merge",
        targetExpId: "expmer01",
        confidence: 0.9,
        rationale: "mer",
      });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });
      const diffs = await listMemoryDiffs(repoRoot, "default", 10);
      const mergeDiff = diffs.find((d) => d.op === "experience_merge");
      expect(mergeDiff).toBeDefined();
      const rev = await revertMemoryDiff(repoRoot, "default", mergeDiff!.id, queue);
      expect(rev.ok).toBe(false);
      expect(rev.reason).toBe("unsupported_op");
    },
    T,
  );

  test(
    "import 目录批量导入",
    async () => {
      const srcDir = join(dir, "import-src");
      await mkdir(join(srcDir, "sub"), { recursive: true });
      const fm = (title: string, rel: string) =>
        serializeFrontmatter(
          {
            title,
            schema_type: "decision",
            source: "default",
            path: rel,
            created_by: "test",
            status: "active",
          },
          `body ${title}`,
        );
      await writeFile(
        join(srcDir, "one.md"),
        fm("导入一", "sources/default/issues/general/decisions/imp-one.md"),
      );
      await writeFile(
        join(srcDir, "sub", "two.md"),
        fm("导入二", "sources/default/issues/general/decisions/imp-two.md"),
      );
      await writeFile(join(srcDir, "bad.txt"), "not md");

      const queue = await makeQueue();
      const imported = await importPath(repoRoot, pack, queue, srcDir, {
        brainId: "default",
        sourceId: "default",
        createdBy: "test",
      });
      expect(imported).toHaveLength(2);
      expect(imported[0]!.destRel).toContain("imp-one");
      expect(imported[1]!.destRel).toContain("imp-two");
      for (const i of imported) {
        expect(existsSync(join(repoRoot, i.destRel))).toBe(true);
      }
    },
    T,
  );

  test(
    "无 .git 时 flush 不 commit",
    async () => {
      const gitDir = join(repoRoot, ".git");
      if (existsSync(gitDir)) await rm(gitDir, { recursive: true, force: true });
      expect(await gitIsRepo(repoRoot)).toBe(false);

      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "nogit",
        body: "x",
        createdBy: "test",
      });
      const cfg = await loadRepoConfig(repoRoot);
      const result = await flushRepoLedger(repoRoot, cfg, "explicit", { throwOnError: false });
      expect(result.committed).toBe(false);
    },
    T,
  );

  test(
    "cost daily_token_cap 超 cap 跳过 LLM",
    async () => {
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      if (!yml.includes("cost:")) {
        yml += "\ncost:\n  daily_token_cap: 100\n  log: .dfmemory/costs.jsonl\n";
      } else {
        yml = yml.replace(/daily_token_cap:\s*\d+/, "daily_token_cap: 100");
      }
      await writeFile(ymlPath, yml, "utf8");

      const cfg = await loadRepoConfig(repoRoot);
      const costCfg = readCostConfig(cfg);
      await appendCostEntry(repoRoot, costCfg, {
        kind: "test",
        tokens_in: 90,
        tokens_out: 5,
        model: "fake",
      });
      expect(await wouldExceedCap(repoRoot, costCfg, 10)).toBe(true);

      let called = false;
      const inner: LLMProvider = {
        id: "inner",
        async judgeDistill() {
          called = true;
          return { candidate: "create", confidence: 1, rationale: "x" };
        },
        async generateAbstract(s: string) {
          return s;
        },
        async generateOverview(c: string[]) {
          return c.join(" ");
        },
        async refineExperience(ctx: ExperienceContext) {
          return {
            title: ctx.title,
            trigger: "t",
            procedure: "p",
            boundary: "b",
            body: ctx.candidate,
          };
        },
      };
      const wrapped = withCostAccounting(inner, repoRoot, costCfg, "test");
      await expect(wrapped.judgeDistill([], "c")).rejects.toThrow("cost cap exceeded");
      expect(called).toBe(false);

      const logs = await readCostLog(repoRoot, costCfg);
      const skip = logs.find((e) => e.skipped && e.reason === "daily_token_cap");
      expect(skip).toBeDefined();
    },
    T,
  );
});
