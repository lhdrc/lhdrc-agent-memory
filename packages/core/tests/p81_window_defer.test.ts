/**
 * P8.1：deferCompile + E_TIMEOUT / E_JOB
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ErrorCodes,
  initMemoryRepo,
  loadPack,
  loadRepoConfig,
  loadSession,
  readOpenSessionId,
  WriteQueue,
  pgliteIndexHooks,
  appendSessionTurns,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 180_000 };

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

function mockLlm(onCall?: () => void): LLMProvider {
  return {
    id: "mock",
    async complete(_req: CompleteRequest): Promise<CompleteResult> {
      onCall?.();
      return {
        text: JSON.stringify({
          items: [{ type: "decision", title: "重试改为固定3次", body: "重试策略改为固定3次。", mentions: [] }],
        }),
      };
    },
    async judgeDistill() {
      return { candidate: "skip" as const, confidence: 0, rationale: "m" };
    },
    async generateAbstract(c: string) {
      return c.slice(0, 10);
    },
    async generateOverview(c: string[]) {
      return c.join("");
    },
    async refineExperience(ctx) {
      return { title: ctx.title, trigger: "t", procedure: "p", boundary: "b", body: ctx.candidate };
    },
  };
}

describe("P8.1 deferCompile", () => {
  test("P81-03 ErrorCodes 含 TIMEOUT / JOB", () => {
    expect(ErrorCodes.TIMEOUT).toBe("E_TIMEOUT");
    expect(ErrorCodes.JOB).toBe("E_JOB");
  });

  test(
    "P81-01 deferCompile 达窗不调 complete",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p81-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, { compile: { window_max_turns: 2 } });
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      let completeCalls = 0;
      const llm = mockLlm(() => {
        completeCalls += 1;
      });
      const base = {
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "test",
        pack,
        queue,
        window: true as const,
        deferCompile: true,
        llm,
      };
      await appendSessionTurns({ ...base, turns: [{ role: "user", text: "第一轮" }] });
      const r = await appendSessionTurns({ ...base, turns: [{ role: "user", text: "第二轮达窗" }] });
      expect(r.shouldCompile).toBe(true);
      expect(r.compiled).toBeUndefined();
      expect(completeCalls).toBe(0);
      const loaded = await loadSession(repoRoot, "default", r.session_id);
      expect(loaded.meta.status).toBe("pending");
      expect(await readOpenSessionId(repoRoot, "default")).toBe(r.session_id);
    },
    T,
  );

  test(
    "P81-02 缺省 deferCompile 达窗仍同步 compile",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p81-02-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, { compile: { window_max_turns: 2 } });
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      let completeCalls = 0;
      const llm = mockLlm(() => {
        completeCalls += 1;
      });
      const base = {
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "test",
        pack,
        queue,
        window: true as const,
        llm,
      };
      await appendSessionTurns({ ...base, turns: [{ role: "user", text: "第一轮" }] });
      const r = await appendSessionTurns({ ...base, turns: [{ role: "user", text: "第二轮达窗" }] });
      expect(r.shouldCompile).toBeUndefined();
      expect(r.compiled).toBeDefined();
      expect((r.compiled?.kept?.length ?? 0) >= 1).toBe(true);
      expect(completeCalls).toBeGreaterThan(0);
    },
    T,
  );

    test(
      "P8.1 compile.job_timeout_ms 默认 120000 且可配置",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "dfmem-p81-timeoutcfg-"));
        const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
        expect((await loadRepoConfig(repoRoot)).compile.job_timeout_ms).toBe(120_000);
        await patchMemoryYml(repoRoot, { compile: { job_timeout_ms: 3000 } });
        expect((await loadRepoConfig(repoRoot)).compile.job_timeout_ms).toBe(3000);
      },
      T,
    );

    test(
      "init 模板 .gitignore 忽略 .dfmemory/jobs/",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "dfmem-p81-gitignore-"));
        const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
        const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
        expect(gitignore).toContain(".dfmemory/jobs/");
      },
      T,
    );

});
