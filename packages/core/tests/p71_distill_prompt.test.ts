/**
 * P7.1 distill prompt 合同 + judge/refine 走 complete()
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  refineSource,
  writeExperience,
  crystallizeExperiences,
  createLLMProvider,
  NoopLLMProvider,
  OpenAILLMProvider,
  EnvMockLLMProvider,
  ErrorCodes,
  loadDistillJudgePrompt,
  loadDistillRefinePrompt,
  formatExistingExperienceLine,
  formatJudgeCandidate,
  formatJudgeUserPrompt,
  formatRefineUserPrompt,
  refineTaskLine,
  parseJudgeDecision,
  parseExperienceResult,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type CompleteResult,
} from "../src/index.ts";

const T = { timeout: 120_000 };

function restoreEnv(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

class RecordingLLM implements LLMProvider {
  readonly id = "fake";
  lastExisting: string[] = [];
  lastCandidate = "";
  lastRefine?: ExperienceContext;
  constructor(
    private decision: DistillDecision,
    private exp?: Partial<ExperienceResult>,
  ) {}
  async judgeDistill(existing: string[], candidate: string): Promise<DistillDecision> {
    this.lastExisting = existing;
    this.lastCandidate = candidate;
    return this.decision;
  }
  async generateAbstract(c: string) {
    return c.slice(0, 100);
  }
  async generateOverview(c: string[]) {
    return c.join("\n");
  }
  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
    this.lastRefine = ctx;
    return {
      title: this.exp?.title ?? ctx.title,
      trigger: this.exp?.trigger ?? "when gateway timeout",
      procedure: this.exp?.procedure ?? "retry 3 times",
      boundary: this.exp?.boundary ?? "idempotent only",
      body: this.exp?.body ?? ctx.candidate,
    };
  }
  async complete(): Promise<CompleteResult> {
    return { text: "{}" };
  }
}

describe("P7.1 distill prompt 合同", () => {
  test("distill-judge-v1.md 含两级词表、偏 create、few-shot", async () => {
    const p = await loadDistillJudgePrompt();
    expect(p).toContain("Few-shot");
    expect(p).toContain("prefer create");
    expect(p).toContain("targetExpId");
    expect(p).toContain("item: merge");
    expect(p).toContain("item: delete");
    expect(p).toContain("superseded");
    expect(p).toContain("sources/");
    expect(p).toContain('"candidate": "create"');
    expect(p).toContain("exp-gw-retry");
    expect(p).toContain("exp-backoff");
  });

  test("distill-refine-v1.md 仍是五字段；结晶同合同", async () => {
    const p = await loadDistillRefinePrompt();
    expect(p).toContain('"title"');
    expect(p).toContain("trigger");
    expect(p).toContain("procedure");
    expect(p).toContain("boundary");
    expect(p).toContain("body");
    expect(p).toContain("Synthesize");
    expect(p).toContain("Cursor Agent Skill");
    expect(p).toContain("Few-shot");
  });

  test("formatJudgeUserPrompt 带 id 与 schema_type", () => {
    const existing = [
      formatExistingExperienceLine({
        id: "exp-fixed-3",
        title: "重试改为固定3次",
        trigger: "网关超时需要重试",
        snippet: "固定 3 次",
      }),
    ];
    const candidate = formatJudgeCandidate({
      path: "sources/default/decisions/1.md",
      schemaType: "decision",
      title: "仅幂等才重试",
      body: "网关超时重试仅适用于幂等请求。",
    });
    const user = formatJudgeUserPrompt(existing, candidate);
    expect(user).toContain("## Existing experiences");
    expect(user).toContain("id: exp-fixed-3");
    expect(user).toContain("schema_type: decision");
    expect(user).toContain("path: sources/default/decisions/1.md");
    expect(user).toContain("## Candidate source");
  });

  test("formatRefineUserPrompt 三种 Task 前缀", () => {
    const base: ExperienceContext = {
      sourcePath: "brains/default/sources/a.md",
      title: "重试",
      candidate: "固定 3 次",
      existingSummaries: ["id: exp1"],
      schemaType: "decision",
    };
    expect(refineTaskLine("create")).toContain("Write a new experience");
    expect(formatRefineUserPrompt({ ...base, task: "create" })).toContain("Write a new experience from the candidate.");
    expect(formatRefineUserPrompt({ ...base, task: "merge", targetExpId: "exp-gw-retry" })).toContain(
      "Merge the candidate into existing experience exp-gw-retry",
    );
    expect(formatRefineUserPrompt({ ...base, task: "synthesize" })).toContain("Synthesize one reusable skill-shaped experience");
  });

  test("parseJudge fail-open skip；refine 缺 title 抛 E_LLM", () => {
    const skip = parseJudgeDecision("not json");
    expect(skip.candidate).toBe("skip");
    expect(skip.rationale).toBe("parse_error");
    expect(() => parseExperienceResult("{}")).toThrow();
    try {
      parseExperienceResult("{}");
    } catch (e: any) {
      expect(e.code).toBe(ErrorCodes.LLM);
    }
    const ok = parseExperienceResult(JSON.stringify({ title: "t", trigger: "when", procedure: "p", boundary: "b", body: "x" }));
    expect(ok.title).toBe("t");
  });
});

describe("P7.1 distill 接线", () => {
  let repoRoot: string;
  let pack: Awaited<ReturnType<typeof loadPack>>;

  const prevKey = process.env.OPENAI_API_KEY;
  const prevMock = process.env.DF_MEMORY_MOCK_COMPLETE;
  const prevDistill = process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL;
  const prevFail = process.env.DF_MEMORY_MOCK_COMPLETE_FAIL;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p71-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    pack = await loadPack("problem-tree");
  });

  afterEach(() => {
    restoreEnv("OPENAI_API_KEY", prevKey);
    restoreEnv("DF_MEMORY_MOCK_COMPLETE", prevMock);
    restoreEnv("DF_MEMORY_MOCK_COMPLETE_DISTILL", prevDistill);
    restoreEnv("DF_MEMORY_MOCK_COMPLETE_FAIL", prevFail);
  });

  async function makeQueue() {
    const cfg = await loadRepoConfig(repoRoot);
    return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  }

  async function capture(title: string, body: string) {
    const queue = await makeQueue();
    return captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title,
      body,
      createdBy: "cli:test",
    });
  }

  test(
    "refine 传给 judge 的 existing 含 id、candidate 含 schema_type；create 带 task",
    async () => {
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "网关超时重试",
        trigger: "支付网关超时",
        procedure: "超时后重试",
        boundary: "同步",
        sourcePaths: ["sources/default/x.md"],
        id: "exp-gw-retry",
        body: "支付网关超时后重试",
      });
      const sourceRel = await capture("仅幂等才重试", "网关超时重试仅适用于幂等请求。");
      const llm = new RecordingLLM({ candidate: "create", confidence: 0.9, rationale: "new" });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });
      expect(llm.lastCandidate).toContain("schema_type: decision");
      expect(llm.lastCandidate).toContain("## Candidate source");
      expect(llm.lastExisting.some((e) => e.includes("id: exp-gw-retry"))).toBe(true);
      expect(llm.lastRefine?.task).toBe("create");
      expect(llm.lastRefine?.schemaType).toBe("decision");
    },
    T,
  );

  test(
    "merge 路径 refineExperience.task=merge 且带 targetExpId",
    async () => {
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "网关超时重试",
        trigger: "支付网关超时",
        procedure: "超时后重试",
        boundary: "同步",
        sourcePaths: ["sources/default/x.md"],
        id: "exp-gw-retry",
      });
      const sourceRel = await capture("仅幂等才重试", "网关超时重试仅适用于幂等请求。");
      const llm = new RecordingLLM({
        candidate: "none",
        item: "merge",
        targetExpId: "exp-gw-retry",
        confidence: 0.8,
        rationale: "complement",
      });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });
      expect(llm.lastRefine?.task).toBe("merge");
      expect(llm.lastRefine?.targetExpId).toBe("exp-gw-retry");
    },
    T,
  );

  test(
    "结晶 refineExperience.task=synthesize",
    async () => {
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时重试",
        trigger: "支付网关超时",
        procedure: "固定重试 3 次",
        boundary: "同步支付",
        sourcePaths: ["sources/default/x.md"],
        etaScore: 0.8,
        support: 3,
      });
      const llm = new RecordingLLM({ candidate: "create", confidence: 1, rationale: "ok" });
      await crystallizeExperiences(repoRoot, {
        brainId: "default",
        queue,
        name: "payment-timeout-fix",
        llm,
      });
      expect(llm.lastRefine?.task).toBe("synthesize");
    },
    T,
  );

  test("P71-01 openai judgeDistill 走 complete purpose=distill 且可 create", async () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    delete process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL;
    process.env.OPENAI_API_KEY = "sk-test";
    let sawPurpose = false;
    let system = "";
    const p = createLLMProvider(
      { provider: "openai" },
      {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role: string; content: string }>;
          };
          system = body.messages?.find((m) => m.role === "system")?.content ?? "";
          const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
          sawPurpose = system.includes("prefer create") && user.includes("## Candidate source");
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      candidate: "create",
                      item: null,
                      targetExpId: null,
                      confidence: 0.9,
                      rationale: "new",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 2 },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(p).toBeInstanceOf(OpenAILLMProvider);
    const d = await p.judgeDistill([], formatJudgeCandidate({ path: "sources/a.md", schemaType: "decision", title: "t", body: "b" }));
    expect(d.candidate).toBe("create");
    expect(sawPurpose).toBe(true);
  });

  test("P71-02 openai refineExperience 走 complete 解析 title/trigger", async () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    delete process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL;
    process.env.OPENAI_API_KEY = "sk-test";
    let user = "";
    const p = createLLMProvider(
      { provider: "openai" },
      {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role: string; content: string }>;
          };
          user = body.messages?.find((m) => m.role === "user")?.content ?? "";
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: "网关超时固定重试3次",
                      trigger: "支付或网关超时应重试",
                      procedure: "1. 固定 3 次",
                      boundary: "仅幂等",
                      body: "短正文",
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );
    const r = await p.refineExperience({
      sourcePath: "brains/default/sources/a.md",
      title: "重试",
      candidate: "固定 3 次",
      existingSummaries: [],
      task: "create",
      schemaType: "decision",
    });
    expect(r.title).toContain("重试");
    expect(r.trigger).toContain("网关");
    expect(user).toContain("Write a new experience from the candidate.");
    expect(user).toContain("schema_type: decision");
  });

  test("P71-05 EnvMock purpose 覆盖：_DISTILL 优先于通用 mock", async () => {
    process.env.DF_MEMORY_MOCK_COMPLETE = JSON.stringify({
      candidate: "skip",
      item: null,
      targetExpId: null,
      confidence: 0,
      rationale: "generic",
    });
    process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL = JSON.stringify({
      candidate: "create",
      item: null,
      targetExpId: null,
      confidence: 0.9,
      rationale: "distill",
    });
    const p = createLLMProvider({ provider: "openai" });
    expect(p).toBeInstanceOf(EnvMockLLMProvider);
    const d = await p.judgeDistill([], "cand");
    expect(d.candidate).toBe("create");
    expect(d.rationale).toBe("distill");
  });

  test("P71-06 EnvMock refineExperience 合法 JSON 成功", async () => {
    process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL = JSON.stringify({
      title: "t",
      trigger: "when",
      procedure: "do",
      boundary: "scope",
      body: "b",
    });
    const p = createLLMProvider({ provider: "openai" });
    const r = await p.refineExperience({
      sourcePath: "s",
      title: "old",
      candidate: "c",
      existingSummaries: [],
      task: "synthesize",
    });
    expect(r.title).toBe("t");
    expect(r.trigger).toBe("when");
  });

  test("P71-07 Noop judgeDistill skip 且 rationale 含 provider=off", async () => {
    const p = new NoopLLMProvider();
    const d = await p.judgeDistill(["a"], "b");
    expect(d.candidate).toBe("skip");
    expect(d.rationale).toContain("provider=off");
    await expect(p.complete({ prompt: "x", purpose: "distill" })).rejects.toMatchObject({
      code: ErrorCodes.DISABLED,
    });
  });

  test("P71-10 judge 非 JSON → skip，不抛", async () => {
    process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL = "not json";
    const p = createLLMProvider({ provider: "openai" });
    const d = await p.judgeDistill([], "cand");
    expect(d.candidate).toBe("skip");
    expect(d.rationale).toBe("parse_error");
  });
});
