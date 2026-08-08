import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  writeExperience,
  writeSkill,
  activateSkill,
  applySkillOutcome,
  crystallizeExperiences,
  runDream,
  captureNode,
  openPglite,
  hybridQuery,
  sha256Hex,
  isMatureExperience,
  MATURITY_ETA_MIN,
  MATURITY_SUPPORT_MIN,
  withCostAccounting,
  readCostConfig,
  type LLMProvider,
  type ExperienceContext,
  type ExperienceResult,
  type DistillDecision,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 60_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

class FakeLLM implements LLMProvider {
  id = "fake";
  async judgeDistill(): Promise<DistillDecision> {
    return { candidate: "create", confidence: 1, rationale: "ok" };
  }
  async generateAbstract(c: string): Promise<string> {
    return c.slice(0, 80);
  }
  async generateOverview(c: string[]): Promise<string> {
    return c.join(" ");
  }
  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
    return {
      title: "结晶技能",
      trigger: ctx.existingSummaries[0] ?? "timeout",
      procedure: "1. 检查重试\n2. 验证阈值",
      boundary: "支付同步调用",
      body: "## Procedure\n1. 检查重试\n\n## Boundary\n支付同步\n\n## Verification\n跑回归\n",
    };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p32-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P3.2 skill / dream / cost", () => {
  test("成熟判定常量", () => {
    expect(isMatureExperience({ eta_score: 0.7, support: 2, counter_examples: [] })).toBe(true);
    expect(isMatureExperience({ eta_score: 0.69, support: 2, counter_examples: [] })).toBe(false);
    expect(isMatureExperience({ eta_score: 0.9, support: 1, counter_examples: [] })).toBe(false);
    expect(isMatureExperience({ eta_score: 0.9, support: 2, counter_examples: ["x"] })).toBe(false);
    expect(MATURITY_ETA_MIN).toBe(0.7);
    expect(MATURITY_SUPPORT_MIN).toBe(2);
  });

  test(
    "P32-01 成熟经验可 crystallize 出 SKILL.md",
    async () => {
      const queue = await makeQueue();
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时重试",
        trigger: "支付网关超时",
        procedure: "固定重试 3 次",
        boundary: "同步支付",
        sourcePaths: ["sources/default/x.md"],
        etaScore: 0.8,
        support: 3,
      });
      expect(expPath).toContain("experiences/");

      const result = await crystallizeExperiences(repoRoot, {
        brainId: "default",
        queue,
        name: "payment-timeout-fix",
        llm: new FakeLLM(),
      });
      expect(result.written.length).toBe(1);
      const skillPath = join(repoRoot, result.written[0]!);
      expect(existsSync(skillPath)).toBe(true);
      const raw = await readFile(skillPath, "utf8");
      expect(raw).toContain("status: candidate");
      expect(raw).toContain("schema_type: skill");
      expect(raw).toContain("## Procedure");
    },
    T,
  );

  test(
    "P32-02 candidate 默认不注入；active 可被 query --type skill 命中",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "retry-skill",
        title: "重试技能",
        trigger: "重试",
        procedure: "固定 3 次",
        boundary: "网关",
        verification: "单测",
        status: "candidate",
      });

      let hits = await (async () => {
        const conn = await openPglite(repoRoot);
        try {
          return await hybridQuery(conn.db, {
            brainId: "default",
            query: "重试技能",
            schemaType: "skill",
            skipCache: true,
          });
        } finally {
          await conn.close();
        }
      })();
      expect(hits.every((h) => !h.path.includes("retry-skill"))).toBe(true);

      await activateSkill(repoRoot, "default", "retry-skill", queue);

      hits = await (async () => {
        const conn = await openPglite(repoRoot);
        try {
          return await hybridQuery(conn.db, {
            brainId: "default",
            query: "重试技能",
            schemaType: "skill",
            skipCache: true,
          });
        } finally {
          await conn.close();
        }
      })();
      expect(hits.some((h) => h.path.includes("retry-skill"))).toBe(true);
    },
    T,
  );

  test(
    "P32-05 outcome --fail 增加 counter_examples",
    async () => {
      const queue = await makeQueue();
      await writeSkill(repoRoot, pack, queue, {
        brainId: "default",
        name: "fail-skill",
        title: "失败技能",
        trigger: "x",
        procedure: "p",
        boundary: "b",
        verification: "v",
        status: "active",
        etaScore: 0.6,
      });
      const r = await applySkillOutcome(repoRoot, "default", "fail-skill", queue, {
        success: false,
        note: "超时仍失败",
      });
      expect(r.eta_score).toBeLessThan(0.6);
      const raw = await readFile(join(repoRoot, r.path), "utf8");
      expect(raw).toContain("超时仍失败");
    },
    T,
  );

  test(
    "P32-03 dream 后 sources 无物理删除",
    async () => {
      const queue = await makeQueue();
      const rel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "保留源",
        body: "dream 不得删我",
        createdBy: "test",
      });
      const before = sha256Hex(await readFile(join(repoRoot, rel), "utf8"));
      await runDream(repoRoot, { brainId: "default", queue, phases: [1, 2, 4, 5] });
      expect(existsSync(join(repoRoot, rel))).toBe(true);
      const after = sha256Hex(await readFile(join(repoRoot, rel), "utf8"));
      expect(after).toBe(before);
    },
    T,
  );

  test(
    "P32-04 kill_switch 关闭 distill 时 dream 跳过阶段 3",
    async () => {
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml = yml.replace(/distill:\s*false/, "distill: true");
      // set kill_switch.distill true
      yml = yml.replace(
        /kill_switch:\n\s*distill:\s*false/,
        "kill_switch:\n    distill: true",
      );
      await Bun.write(ymlPath, yml);

      const queue = await makeQueue();
      const result = await runDream(repoRoot, { brainId: "default", queue, phases: [3] });
      expect(result.phases[0]!.skipped).toBe(true);
      expect(result.phases[0]!.reason).toContain("kill_switch");
    },
    T,
  );

  test(
    "costs.jsonl 有写入",
    async () => {
      const cfg = await loadRepoConfig(repoRoot);
      const costCfg = readCostConfig(cfg);
      const wrapped = withCostAccounting(new FakeLLM(), repoRoot, costCfg, "test");
      await wrapped.refineExperience({
        sourcePath: "x",
        title: "t",
        candidate: "body",
        existingSummaries: [],
      });
      const logAbs = join(repoRoot, costCfg.log);
      expect(existsSync(logAbs)).toBe(true);
      const raw = await readFile(logAbs, "utf8");
      expect(raw).toContain("refineExperience");
      expect(raw).toContain("tokens_in");
    },
    T,
  );

  test("skill 状态机 candidate → active → archived", async () => {
    const queue = await makeQueue();
    await writeSkill(repoRoot, pack, queue, {
      brainId: "default",
      name: "sm-skill",
      title: "状态机",
      trigger: "t",
      procedure: "p",
      boundary: "b",
      verification: "v",
      status: "candidate",
      etaScore: 0.3,
    });
    await activateSkill(repoRoot, "default", "sm-skill", queue);
    let raw = await readFile(join(repoRoot, "brains/default/skills/sm-skill/SKILL.md"), "utf8");
    expect(raw).toContain("status: active");
    await applySkillOutcome(repoRoot, "default", "sm-skill", queue, {
      success: false,
      note: "坏了",
    });
    raw = await readFile(join(repoRoot, "brains/default/skills/sm-skill/SKILL.md"), "utf8");
    expect(raw).toContain("status: archived");
  }, T);
});
