/**
 * P7.5 inbox retry + revert merge/skill/noop
 */
import { describe, expect, test } from "bun:test";
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
  writeExperience,
  crystallizeExperiences,
  refineSource,
  revertMemoryDiff,
  listMemoryDiffs,
  appendMemoryDiff,
  parseFrontmatter,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type CompleteResult,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const decisionFx = join(import.meta.dir, "../../adapters/ingest-session/fixtures/decision.jsonl");
const DECISION_COMPLETE = JSON.stringify({
  items: [{ type: "decision", title: "重试改为固定3次", body: "重试策略改为固定3次，不再使用指数退避。", mentions: [] }],
});

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

function mockEnv(extra?: Record<string, string>): Record<string, string> {
  return { OPENAI_API_KEY: "sk-test", DF_MEMORY_MOCK_COMPLETE: DECISION_COMPLETE, ...extra };
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
  async generateAbstract(c: string): Promise<string> {
    return c.slice(0, 80);
  }
  async generateOverview(c: string[]): Promise<string> {
    return c.join(" ");
  }
  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
    return {
      title: this.exp?.title ?? ctx.title,
      trigger: this.exp?.trigger ?? "t",
      procedure: this.exp?.procedure ?? "merged-procedure",
      boundary: this.exp?.boundary ?? "merged-boundary",
      body: this.exp?.body ?? "merged-body",
    };
  }
  async complete(): Promise<CompleteResult> {
    return { text: JSON.stringify({ items: [] }) };
  }
}

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

describe("P7.5 CLI ops", () => {
  test(
    "P75-01: inbox retry failed session → kept≥1",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const fail = await runCli(repoRoot, ["ingest", "--adapter", "session", "--input", decisionFx, "--json"], {
        OPENAI_API_KEY: "sk-test",
        DF_MEMORY_MOCK_COMPLETE_FAIL: "1",
      });
      expect(fail.exit).not.toBe(0);
      const listed = await runCli(repoRoot, ["inbox", "list", "--json", "--status", "failed"]);
      const sessions = JSON.parse(listed.out) as { sessions: Array<{ session_id: string }> };
      const id = sessions.sessions[0]!.session_id;
      const retry = await runCli(repoRoot, ["inbox", "retry", id, "--json"], mockEnv());
      expect(retry.exit).toBe(0);
      const parsed = JSON.parse(retry.out) as { kept: Array<{ path?: string }> };
      expect(parsed.kept.length).toBeGreaterThanOrEqual(1);
      expect(parsed.kept.some((k) => k.path)).toBe(true);
    },
    T,
  );

  test(
    "P75-02: inbox retry 与 ingest --retry 路径集合一致",
    async () => {
      async function failThenRetry(
        kind: "inbox" | "ingest",
      ): Promise<string[]> {
        const dir = await mkdtemp(join(tmpdir(), `dfmem-p75-02-${kind}-`));
        const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
        await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
        await runCli(repoRoot, ["ingest", "--adapter", "session", "--input", decisionFx, "--json"], {
          OPENAI_API_KEY: "sk-test",
          DF_MEMORY_MOCK_COMPLETE_FAIL: "1",
        });
        const listed = await runCli(repoRoot, ["inbox", "list", "--json", "--status", "failed"]);
        const sessions = JSON.parse(listed.out) as { sessions: Array<{ session_id: string }> };
        const id = sessions.sessions[0]!.session_id;
        const args =
          kind === "inbox"
            ? ["inbox", "retry", id, "--json"]
            : ["ingest", "--adapter", "session", "--retry", id, "--json"];
        const retry = await runCli(repoRoot, args, mockEnv());
        expect(retry.exit).toBe(0);
        return (JSON.parse(retry.out) as { kept: Array<{ path?: string; title?: string }> }).kept
          .map((k) => k.title ?? k.path ?? "")
          .filter(Boolean)
          .sort();
      }
      const inbox = await failThenRetry("inbox");
      const ingest = await failThenRetry("ingest");
      expect(inbox.length).toBeGreaterThanOrEqual(1);
      expect(inbox).toEqual(ingest);
    },
    T,
  );

  test(
    "P75-03: merge 可还原 snapshot",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const sourceRel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "merge源",
        body: "合并进已有经验。",
        createdBy: "cli:test",
      });
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "待合并",
        trigger: "t",
        procedure: "original-procedure",
        boundary: "original-boundary",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expmer75",
        body: "original-body",
      });
      const llm = new FakeLLM({
        candidate: "none",
        item: "merge",
        targetExpId: "expmer75",
        confidence: 0.9,
        rationale: "mer",
      });
      await refineSource(repoRoot, { brainId: "default", path: sourceRel, queue, llm });
      const merged = await readFile(join(repoRoot, expPath), "utf8");
      expect(merged).toContain("merged-procedure");
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      const mergeDiff = diffs.find((d) => d.op === "experience_merge");
      expect(mergeDiff?.revert?.snapshot?.procedure).toBe("original-procedure");
      const rev = await revertMemoryDiff(repoRoot, "default", mergeDiff!.id, queue);
      expect(rev.ok).toBe(true);
      const restored = parseFrontmatter(await readFile(join(repoRoot, expPath), "utf8"));
      expect(String(restored.data.procedure)).toBe("original-procedure");
      expect(restored.body).toContain("original-body");
      expect(String(restored.data.procedure)).not.toContain("merged-procedure");
      const after = await listMemoryDiffs(repoRoot, "default", 20);
      expect(after.some((d) => d.decision?.revert_of === mergeDiff!.id)).toBe(true);
    },
    T,
  );

  test(
    "P75-04: 无快照 merge → unsupported_op exit 2",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await makeQueue(repoRoot);
      const entry = await appendMemoryDiff(repoRoot, "default", {
        op: "experience_merge",
        paths_written: ["brains/default/experiences/missing.md"],
        paths_readonly_refs: [],
        decision: {},
      });
      const r = await runCli(repoRoot, ["revert", entry.id, "--json"]);
      expect(r.exit).toBe(2);
      const json = JSON.parse(r.out || r.err) as { ok: boolean; reason: string; op?: string };
      expect(json.ok).toBe(false);
      expect(json.reason).toBe("unsupported_op");
      expect(json.op).toBe("experience_merge");
    },
    T,
  );

  test(
    "P75-05: skill_create revert 归档",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-05-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
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
        name: "payment-timeout-fix",
        llm: new FakeLLM({ candidate: "create", confidence: 1, rationale: "ok" }),
      });
      expect(result.written.length).toBe(1);
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      const skillDiff = diffs.find((d) => d.op === "skill_create");
      expect(skillDiff?.revert?.action).toBe("archive_path");
      const rev = await revertMemoryDiff(repoRoot, "default", skillDiff!.id, queue);
      expect(rev.ok).toBe(true);
      const raw = await readFile(join(repoRoot, result.written[0]!), "utf8");
      expect(raw).toContain("status: archived");
    },
    T,
  );

  test(
    "P75-06: revert noop 不改文件",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "noop经验",
        trigger: "t",
        procedure: "p",
        boundary: "b",
        sourcePaths: ["sources/default/x.md"],
        id: "expnoop75",
      });
      const before = await readFile(join(repoRoot, expPath), "utf8");
      const entry = await appendMemoryDiff(repoRoot, "default", {
        op: "noop",
        paths_written: [],
        paths_readonly_refs: [expPath],
        decision: { candidate: "skip" },
      });
      const r = await runCli(repoRoot, ["revert", entry.id, "--json"]);
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { ok: boolean; reason?: string };
      expect(json.ok).toBe(true);
      expect(json.reason).toBe("already_noop");
      expect(await readFile(join(repoRoot, expPath), "utf8")).toBe(before);
    },
    T,
  );

  test(
    "P75-07: 未知 inbox 子命令含 retry",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["inbox", "foo"]);
      expect(r.exit).toBe(2);
      expect(`${r.out}\n${r.err}`).toContain("retry");
    },
    T,
  );

  test("P75 help 含 retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p75-help-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["inbox", "--help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("retry");
  });
});
