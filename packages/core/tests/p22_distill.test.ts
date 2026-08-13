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
  refineSource,
  validateExperienceWrite,
  writeExperience,
  hybridQuery,
  openPglite,
  sha256Hex,
  revertMemoryDiff,
  listMemoryDiffs,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type CompleteResult,
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

  async judgeDistill(_existing: string[], _candidate: string): Promise<DistillDecision> {
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
      trigger: this.exp?.trigger ?? "when gateway timeout",
      procedure: this.exp?.procedure ?? "retry 3 times with fixed backoff",
      boundary: this.exp?.boundary ?? "only for idempotent requests",
      body: this.exp?.body ?? ctx.candidate,
    };
  }

  async complete(): Promise<CompleteResult> {
    return { text: JSON.stringify({ items: [] }) };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p22-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P2.2 蒸馏基础", () => {
  test(
    "P22-01 FakeLLM create → experiences/ 文件存在",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const queue = await makeQueue();
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "new pattern" });

      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });

      expect(result.written).toBe(1);
      expect(result.paths?.length).toBe(1);
      const expPath = result.paths![0]!;
      expect(expPath).toMatch(/brains\/default\/experiences\/.*\.md$/);
      expect(existsSync(join(repoRoot, expPath))).toBe(true);

      const raw = await readFile(join(repoRoot, expPath), "utf8");
      expect(raw).toContain("schema_type: experience");
      expect(raw).toContain("eta_score: 0.5");
      expect(raw).toContain("support: 0");
      expect(raw).toContain("abstract:");
    },
    T,
  );

  test(
    "P22-05 abstract 字段存在（启发式）",
    async () => {
      const sourceRel = await capture("摘要测试", "这是一段足够长的正文用于生成启发式 abstract 字段内容。");
      const queue = await makeQueue();
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "abs" });
      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });
      const raw = await readFile(join(repoRoot, result.paths![0]!), "utf8");
      expect(raw).toMatch(/abstract:\s*.+/);
    },
    T,
  );

  test(
    "P22-02 delete 判定 → sources 文件 hash 不变",
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
        id: "expold001",
      });

      const sourceHashBefore = sha256Hex(await readFile(join(repoRoot, sourceRel), "utf8"));
      const llm = new FakeLLM({
        candidate: "none",
        item: "delete",
        targetExpId: "expold001",
        confidence: 0.8,
        rationale: "supersede old",
      });

      await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });

      const sourceHashAfter = sha256Hex(await readFile(join(repoRoot, sourceRel), "utf8"));
      expect(sourceHashAfter).toBe(sourceHashBefore);

      const expRaw = await readFile(join(repoRoot, expPath), "utf8");
      expect(expRaw).toContain("status: superseded");
    },
    T,
  );

  test(
    "P22-03 llm off → refine skipped >0，无新 experience",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const expDir = join(repoRoot, "brains", "default", "experiences");
      const before = existsSync(expDir) ? (await readdir(expDir)).filter((f) => f.endsWith(".md")).length : 0;

      const queue = await makeQueue();
      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
      });

      expect(result.reason).toBe("llm_off");
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.written).toBe(0);

      const after = existsSync(expDir) ? (await readdir(expDir)).filter((f) => f.endsWith(".md")).length : 0;
      expect(after).toBe(before);
    },
    T,
  );

  test(
    "P22-06 refine 后 query --type experience 能命中",
    async () => {
      const sourceRel = await capture("网关重试经验", "固定重试 3 次应对网关超时。");
      const queue = await makeQueue();
      const llm = new FakeLLM(
        { candidate: "create", confidence: 0.9, rationale: "test" },
        { title: "网关重试经验", procedure: "固定重试 3 次应对网关超时" },
      );

      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });
      expect(result.written).toBe(1);

      const conn = await openPglite(repoRoot);
      try {
        const hits = await hybridQuery(conn.db, {
          brainId: "default",
          query: "网关重试",
          limit: 10,
          schemaType: "experience",
          repoRoot,
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.path === result.paths![0])).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P22-07 非法 experience frontmatter → validate 拒绝，无写盘",
    async () => {
      const result = validateExperienceWrite(repoRoot, pack, {
        brainId: "default",
        title: "",
        trigger: "",
        procedure: "",
        boundary: "",
        sourcePaths: [],
      });
      expect(result.ok).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);

      const expDir = join(repoRoot, "brains", "default", "experiences");
      const count = existsSync(expDir) ? (await readdir(expDir)).length : 0;
      expect(count).toBe(0);
    },
    T,
  );

  test(
    "P22-04 revert experience_create → archived",
    async () => {
      const sourceRel = await capture("回滚测试", "测试 revert 流程。");
      const queue = await makeQueue();
      const llm = new FakeLLM({ candidate: "create", confidence: 0.9, rationale: "test" });

      await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
      });

      const diffs = await listMemoryDiffs(repoRoot, "default", 5);
      const createDiff = diffs.find((d) => d.op === "experience_create");
      expect(createDiff).toBeDefined();

      const revertResult = await revertMemoryDiff(repoRoot, "default", createDiff!.id, queue);
      expect(revertResult.ok).toBe(true);

      const raw = await readFile(join(repoRoot, revertResult.path!), "utf8");
      expect(raw).toContain("status: archived");
    },
    T,
  );
});
