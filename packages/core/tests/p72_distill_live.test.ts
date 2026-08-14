/**
 * P7.2 Distill 真路径：refine / 懒蒸 / 自动 candidate / eval:distill
 *
 * EnvMock distill JSONL：第一行 judge，第二行 refineExperience（P7.2 §3.2）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  refineSource,
  compileSession,
  crystallizeExperiences,
  writeExperience,
  parseFrontmatter,
  listMemoryDiffs,
  sha256Hex,
  ErrorCodes,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type CompleteResult,
  type CaptureOptions,
  captureWrite,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const evalScript = join(import.meta.dir, "../../../evals/run.ts");

const JUDGE_CREATE = JSON.stringify({
  candidate: "create",
  item: null,
  targetExpId: null,
  confidence: 0.9,
  rationale: "new",
});
const JUDGE_SKIP = JSON.stringify({
  candidate: "skip",
  item: null,
  targetExpId: null,
  confidence: 0.9,
  rationale: "covered",
});
const REFINE_JSON = JSON.stringify({
  title: "网关超时固定重试3次",
  trigger: "网关超时需要重试",
  procedure: "固定 3 次",
  boundary: "仅幂等",
  body: "固定三次重试",
});
/** judge create + refine 合法 JSON */
const DISTILL_JSONL = `${JUDGE_CREATE}\n${REFINE_JSON}`;
const COMPILE_ONE = JSON.stringify({
  items: [{ type: "decision", title: "重试改为固定3次", body: "重试策略改为固定3次。", mentions: [] }],
});

function restoreEnv(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

async function patchMemoryYml(repoRoot: string, patch: Record<string, unknown>): Promise<void> {
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

async function runCli(
  repoRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...extraEnv,
  };
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

class CountingLLM implements LLMProvider {
  readonly id = "fake";
  judgeCalls = 0;
  constructor(
    private decision: DistillDecision,
    private exp?: Partial<ExperienceResult>,
  ) {}
  async judgeDistill(): Promise<DistillDecision> {
    this.judgeCalls++;
    return this.decision;
  }
  async generateAbstract(c: string) {
    return c.slice(0, 100);
  }
  async generateOverview(c: string[]) {
    return c.join("\n");
  }
  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
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

describe("P7.2 distill live", () => {
  let repoRoot: string;
  let pack: Awaited<ReturnType<typeof loadPack>>;
  const prev: Record<string, string | undefined> = {};
  const MOCK_KEYS = [
    "OPENAI_API_KEY",
    "DF_MEMORY_MOCK_COMPLETE",
    "DF_MEMORY_MOCK_COMPLETE_DISTILL",
    "DF_MEMORY_MOCK_COMPLETE_COMPILE",
    "DF_MEMORY_MOCK_COMPLETE_FAIL",
  ];

  beforeEach(async () => {
    for (const k of MOCK_KEYS) prev[k] = process.env[k];
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p72-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    pack = await loadPack("problem-tree");
  });

  afterEach(() => {
    for (const k of MOCK_KEYS) restoreEnv(k, prev[k]);
  });

  async function makeQueue() {
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

  async function listExperiences(): Promise<string[]> {
    const dir = join(repoRoot, "brains", "default", "experiences");
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  }

  test("init memory.yml 含 distill.lazy_min_sources / auto_crystallize", async () => {
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    expect(yml).toContain("lazy_min_sources: 5");
    expect(yml).toContain("auto_crystallize: true");
  });

  test(
    "P72-01 openai mock JSONL 能写 experience 且源字节不变",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const path = await capture("重试改为固定3次", "网关超时改为固定重试 3 次。");
      const before = sha256Hex(await readFile(join(repoRoot, path), "utf8"));
      const r = await runCli(repoRoot, ["refine", "--path", path, "--json"], {
        DF_MEMORY_MOCK_COMPLETE_DISTILL: DISTILL_JSONL,
      });
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { written: number };
      expect(json.written).toBe(1);
      expect((await listExperiences()).length).toBe(1);
      expect(sha256Hex(await readFile(join(repoRoot, path), "utf8"))).toBe(before);
    },
    T,
  );

  test(
    "P72-02 provider=off refine --json skipped_reason",
    async () => {
      await capture("off源", "不会被蒸。");
      const r = await runCli(repoRoot, ["refine", "--json"]);
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { written: number; skipped_reason?: string; paths?: string[] };
      expect(json.written).toBe(0);
      expect(json.skipped_reason).toMatch(/off|disabled|llm_off/);
      expect(json.paths ?? []).toEqual([]);
    },
    T,
  );

  test(
    "P72-03 懒蒸馏：已蒸源全量 refine 不再 judge",
    async () => {
      const path = await capture("仅幂等才重试", "网关超时重试仅适用于幂等请求。");
      const llm = new CountingLLM({ candidate: "create", confidence: 1, rationale: "n" });
      const queue = await makeQueue();
      await refineSource(repoRoot, { brainId: "default", path, queue, llm });
      expect(llm.judgeCalls).toBe(1);
      const again = await refineSource(repoRoot, { brainId: "default", queue, llm });
      expect(again.lazy_omitted).toBeGreaterThanOrEqual(1);
      expect(llm.judgeCalls).toBe(1);
      expect((await listExperiences()).length).toBe(1);
    },
    T,
  );

  test(
    "P72-04 --path 可重蒸已蒸源（仍调 judge）",
    async () => {
      const path = await capture("重试", "固定 3 次。");
      const queue = await makeQueue();
      const createLlm = new CountingLLM({ candidate: "create", confidence: 1, rationale: "n" });
      await refineSource(repoRoot, { brainId: "default", path, queue, llm: createLlm });
      const skipLlm = new CountingLLM({ candidate: "skip", confidence: 1, rationale: "covered" });
      await refineSource(repoRoot, { brainId: "default", path, queue, llm: skipLlm });
      expect(skipLlm.judgeCalls).toBe(1);
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.some((d) => d.op === "noop")).toBe(true);
    },
    T,
  );

  test(
    "P72-05 dream --phases 3 mock create written≥1",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      await capture("重试改为固定3次", "网关超时改为固定重试 3 次。");
      const r = await runCli(repoRoot, ["dream", "--phases", "3", "--json"], {
        DF_MEMORY_MOCK_COMPLETE_DISTILL: DISTILL_JSONL,
      });
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { phases: Array<{ details?: { written?: number } }> };
      const written = json.phases.reduce((s, p) => s + (p.details?.written ?? 0), 0);
      expect(written).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "P72-06 eval --distill receipt used_refine 且 written≥1",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p72-eval-"));
      const proc = Bun.spawn({
        cmd: [bunBin, evalScript, "--distill", "--json"],
        cwd: join(import.meta.dir, "../../.."),
        env: { ...process.env, DF_EVAL_RECEIPT_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit, err).toBe(0);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: { used_refine?: boolean; written?: number };
        used_refine?: boolean;
        written?: number;
      };
      expect(latest.metrics.used_refine ?? latest.used_refine).toBe(true);
      expect((latest.metrics.written ?? latest.written) ?? 0).toBeGreaterThanOrEqual(1);
      expect(out.length + err.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P72-07 结晶 openai 失败可见且不写 SKILL.md",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
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
      process.env.DF_MEMORY_MOCK_COMPLETE_FAIL = "1";
      const result = await crystallizeExperiences(repoRoot, {
        brainId: "default",
        queue,
        name: "payment-timeout-fix",
      });
      expect(result.written.length).toBe(0);
      expect(result.errors?.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(repoRoot, "brains/default/skills/payment-timeout-fix/SKILL.md"))).toBe(false);
    },
    T,
  );

  test(
    "P72-08 结晶 off 启发式仍可写出 candidate",
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
      const result = await crystallizeExperiences(repoRoot, {
        brainId: "default",
        queue,
        name: "payment-timeout-off",
      });
      expect(result.written.length).toBe(1);
      const raw = await readFile(join(repoRoot, result.written[0]!), "utf8");
      expect(raw).toContain("status: candidate");
    },
    T,
  );

  test(
    "P72-09 真 skip 才 noop；create 无 noop",
    async () => {
      const path = await capture("重试策略", "改为固定3次。");
      const queue = await makeQueue();
      await refineSource(repoRoot, {
        brainId: "default",
        path,
        queue,
        llm: new CountingLLM({ candidate: "skip", confidence: 1, rationale: "skip" }),
      });
      let diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.some((d) => d.op === "noop")).toBe(true);

      const path2 = await capture("另一决策", "用指数退避。");
      await refineSource(repoRoot, {
        brainId: "default",
        path: path2,
        queue,
        llm: new CountingLLM({ candidate: "create", confidence: 1, rationale: "new" }),
      });
      diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.some((d) => d.op === "experience_create")).toBe(true);
      const createDiffs = diffs.filter((d) => d.paths_readonly_refs?.includes(path2));
      expect(createDiffs.some((d) => d.op === "noop")).toBe(false);
    },
    T,
  );

  test(
    "P72-10 compile 后够数才蒸（lazy_min_sources=1）",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        distill: { lazy_min_sources: 1, auto_crystallize: false },
      });
      const r = await runCli(
        repoRoot,
        ["remember", "--body", "我们决定重试改为固定3次", "--json"],
        {
          DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
          DF_MEMORY_MOCK_COMPLETE_DISTILL: DISTILL_JSONL,
        },
      );
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { kept: unknown[]; distill?: { written?: number } };
      expect(json.kept.length).toBeGreaterThanOrEqual(1);
      expect(json.distill?.written).toBeGreaterThanOrEqual(1);
      expect((await listExperiences()).length).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "P72-11 不够数不蒸",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        distill: { lazy_min_sources: 5 },
      });
      const r = await runCli(
        repoRoot,
        ["remember", "--body", "我们决定重试改为固定3次", "--json"],
        {
          DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
          DF_MEMORY_MOCK_COMPLETE_DISTILL: DISTILL_JSONL,
        },
      );
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { distill?: { written?: number } };
      expect(json.distill).toBeUndefined();
      expect((await listExperiences()).length).toBe(0);
    },
    T,
  );

  test(
    "P72-12 自动 candidate skill",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        distill: { auto_crystallize: true },
      });
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时重试 A",
        trigger: "支付网关超时",
        procedure: "固定重试 3 次",
        boundary: "同步",
        sourcePaths: ["sources/default/a.md"],
        etaScore: 0.8,
        support: 3,
      });
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时重试 B",
        trigger: "支付网关超时",
        procedure: "超时后重试",
        boundary: "同步",
        sourcePaths: ["sources/default/b.md"],
        etaScore: 0.8,
        support: 2,
      });
      process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL = REFINE_JSON;
      const result = await refineSource(repoRoot, { brainId: "default", queue });
      expect(result.crystallized?.length).toBeGreaterThanOrEqual(1);
      const skillRel = result.crystallized![0]!;
      const raw = await readFile(join(repoRoot, skillRel), "utf8");
      const { data } = parseFrontmatter(raw);
      expect(data.status).toBe("candidate");
      expect(data.status).not.toBe("active");
    },
    T,
  );

  test(
    "P72-13 off 不自动结晶",
    async () => {
      const queue = await makeQueue();
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "支付超时重试",
        trigger: "支付网关超时",
        procedure: "固定重试 3 次",
        boundary: "同步",
        sourcePaths: ["sources/default/x.md"],
        etaScore: 0.8,
        support: 3,
      });
      await refineSource(repoRoot, { brainId: "default", queue });
      expect(existsSync(join(repoRoot, "brains/default/skills"))).toBe(true);
      const skillsRoot = join(repoRoot, "brains", "default", "skills");
      const names = existsSync(skillsRoot) ? await readdir(skillsRoot) : [];
      expect(names.filter((n) => n !== ".gitkeep" && !n.startsWith("."))).toEqual([]);
    },
    T,
  );

  test(
    "P72-14 蒸馏失败不回滚 L0",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        distill: { lazy_min_sources: 1, auto_crystallize: false },
      });
      process.env.DF_MEMORY_MOCK_COMPLETE_DISTILL = `${JUDGE_CREATE}\nnot json`;
      const queue = await makeQueue();
      let executes = 0;
      const orig = queue.execute.bind(queue);
      queue.execute = async (fn, label, execOpts) => {
        executes++;
        return orig(fn, label, execOpts);
      };
      const llm: LLMProvider = {
        id: "openai",
        async complete() {
          return { text: COMPILE_ONE };
        },
        async judgeDistill() {
          return { candidate: "skip", confidence: 0, rationale: "n" };
        },
        async generateAbstract(c) {
          return c.slice(0, 10);
        },
        async generateOverview(c) {
          return c.join("");
        },
        async refineExperience(ctx) {
          return { title: ctx.title, trigger: "t", procedure: "p", boundary: "b", body: ctx.candidate };
        },
      };
      const result = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "test",
        pack,
        queue,
        turns: [{ role: "user", text: "我们决定重试改为固定3次" }],
        llm,
        captureWriteFn: async (root, p, opts: CaptureOptions) => captureWrite(root, p, opts),
      });
      expect(result.kept.length).toBe(1);
      expect(result.kept[0]?.path).toBeTruthy();
      expect(existsSync(join(repoRoot, result.kept[0]!.path!))).toBe(true);
      expect(result.distill?.error || result.distill?.written === 0).toBeTruthy();
      expect(executes).toBeGreaterThanOrEqual(1);
    },
    T,
  );
});
