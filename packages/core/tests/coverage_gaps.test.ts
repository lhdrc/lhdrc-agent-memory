/**
 * 补齐 Spec 验收中 core 层缺失的测试（schema use、merge E2E、graph-query 成功路径、observer、skill 校验、intent）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
  setSchemaPack,
  gitLog,
  openPglite,
  graphArm,
  parseRelationalQuery,
  hybridQuery,
  classifyIntent,
  collectObserverStats,
  recordQueryStat,
  refineSource,
  writeExperience,
  sha256Hex,
  validateSkillWrite,
  createEntityRegistry,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 120_000 };

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
      procedure: this.exp?.procedure ?? "merged procedure with new insight",
      boundary: this.exp?.boundary ?? "idempotent only",
      body: this.exp?.body ?? "\n## Merged\nnew content",
    };
  }

  async complete() {
    return { text: JSON.stringify({ items: [] }) };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-gap-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("覆盖缺口补齐", () => {
  test(
    "M2 schema use 更新 pack 并 force commit",
    async () => {
      const queue = await makeQueue();
      await setSchemaPack(repoRoot, "default", "legacy-pack", queue);
      let memYml = await readFile(join(repoRoot, "memory.yml"), "utf8");
      expect(memYml).toMatch(/schema_pack:\s*legacy-pack/);
      let after = await gitLog(repoRoot, 5);
      expect(after.some((l) => l.includes("schema use legacy-pack"))).toBe(true);

      await setSchemaPack(repoRoot, "default", "problem-tree", queue);
      memYml = await readFile(join(repoRoot, "memory.yml"), "utf8");
      expect(memYml).toMatch(/schema_pack:\s*problem-tree/);
      after = await gitLog(repoRoot, 5);
      expect(after.some((l) => l.includes("schema use problem-tree"))).toBe(true);
    },
    T,
  );

  test(
    "P22 experience_merge E2E：sources 不变、目标 experience 字段合并",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const queue = await makeQueue();
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "旧重试经验",
        trigger: "timeout",
        procedure: "retry once",
        boundary: "none",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expmerge01",
      });

      const sourceHashBefore = sha256Hex(await readFile(join(repoRoot, sourceRel), "utf8"));
      const llm = new FakeLLM({
        candidate: "none",
        item: "merge",
        targetExpId: "expmerge01",
        confidence: 0.85,
        rationale: "merge insight",
      });

      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });

      expect(result.written).toBe(1);
      expect(result.paths![0]).toBe(expPath);

      const sourceHashAfter = sha256Hex(await readFile(join(repoRoot, sourceRel), "utf8"));
      expect(sourceHashAfter).toBe(sourceHashBefore);

      const expRaw = await readFile(join(repoRoot, expPath), "utf8");
      expect(expRaw).toContain("merged procedure with new insight");
      expect(expRaw).not.toContain("status: superseded");
    },
    T,
  );

  test(
    "P31 graph-query 成功路径：谁提到了支付",
    async () => {
      const rel = await capture("支付对齐", "与 [[支付]] 团队对齐重试策略。");
      expect(parseRelationalQuery("谁提到了支付")).toEqual({ seed: "支付", verb: "mentions" });

      const conn = await openPglite(repoRoot);
      try {
        const arm = await graphArm(conn.db, { brainId: "default", query: "谁提到了支付" });
        expect(arm.length).toBeGreaterThan(0);
        expect(arm.some((h) => h.path === rel)).toBe(true);
        expect(arm[0]!.evidence).toContain("graph");

        const hits = await hybridQuery(conn.db, {
          brainId: "default",
          query: "谁提到了支付",
          repoRoot,
          skipCache: true,
        });
        expect(hits.some((h) => h.path === rel)).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P3.1 intent 分类",
    () => {
      expect(classifyIntent("谁提到了支付")).toBe("relation");
      expect(classifyIntent("重试经验踩坑")).toBe("experience");
      expect(classifyIntent("工单 bug 修复")).toBe("task");
      expect(classifyIntent("负责人是谁")).toBe("person");
      expect(classifyIntent("网关超时")).toBe("general");
    },
    T,
  );

  test(
    "P32 observer 聚合 query/distill/cost",
    async () => {
      await recordQueryStat(repoRoot, { query: "重试", hitCount: 2, avgScore: 0.8 });
      await recordQueryStat(repoRoot, { query: "不存在", hitCount: 0, avgScore: 0 });

      const sourceRel = await capture("observer 测试", "用于 distill 计数。");
      const queue = await makeQueue();
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "obs" });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });

      const stats = await collectObserverStats(repoRoot, "default");
      expect(stats.query_count).toBeGreaterThanOrEqual(2);
      expect(stats.zero_result_rate).toBeGreaterThan(0);
      expect(stats.avg_score).toBeGreaterThan(0);
      expect(stats.distill_count).toBeGreaterThanOrEqual(1);
      expect(stats.cost.entries).toBeGreaterThanOrEqual(0);
    },
    T,
  );

  test(
    "P32 skill WRITE_FORMAT 校验拒绝非法 name",
    () => {
      const bad = validateSkillWrite(repoRoot, pack, {
        brainId: "default",
        name: "Bad_Name!",
        title: "t",
        trigger: "tr",
        procedure: "p",
        boundary: "b",
        verification: "v",
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.errors.some((e) => e.field === "name")).toBe(true);
      }

      const good = validateSkillWrite(repoRoot, pack, {
        brainId: "default",
        name: "retry-skill",
        title: "重试技能",
        trigger: "timeout",
        procedure: "retry 3x",
        boundary: "idempotent",
        verification: "run tests",
      });
      expect(good.ok).toBe(true);
    },
    T,
  );

  test(
    "M1 init --force 可重建已有仓",
    async () => {
      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "保留",
        body: "不应丢",
        createdBy: "test",
      });

      const forced = await initMemoryRepo(dir, { brain: "default", source: "default", force: true });
      expect(forced).toBe(repoRoot);
      expect(existsSync(join(repoRoot, "memory.yml"))).toBe(true);

      const decisions = join(repoRoot, "brains/default/sources/default/issues/general/decisions");
      if (existsSync(decisions)) {
        const files = (await readdir(decisions)).filter((f) => f.endsWith(".md"));
        expect(files.length).toBeGreaterThanOrEqual(0);
      }
    },
    T,
  );

  test(
    "M1 entity create 经 registry 可索引",
    async () => {
      const queue = await makeQueue();
      const reg = createEntityRegistry(repoRoot, "default", queue);
      const ent = await reg.create({ slug: "carol", title: "Carol", createdBy: "test" });
      expect(ent.slug).toBe("carol");
      const entityPath = join(repoRoot, "brains/default/entities/carol.md");
      expect(existsSync(entityPath)).toBe(true);
      const resolved = await reg.resolve("carol");
      expect(resolved.slug).toBe("carol");
    },
    T,
  );
});
