/**
 * P6.6 提取合同：类型说明书、prefetch、source_turns、JSON 修复
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  compileSession,
  captureNode,
  ErrorCodes,
  loadSessionExtractPrompt,
  ALREADY_IN_KB_HEADING,
  JSON_REPAIR_SUFFIX,
  MemoryError,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 180_000 };

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
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

function mockLlm(text: string | ((req: CompleteRequest) => string), onCall?: (req: CompleteRequest) => void): LLMProvider {
  return {
    id: "mock",
    async complete(req): Promise<CompleteResult> {
      onCall?.(req);
      const t = typeof text === "function" ? text(req) : text;
      return { text: t };
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

function decisionJson(title = "重试改为固定3次", body = "重试策略改为固定3次，不再使用指数退避。", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    items: [{ type: "decision", title, body, mentions: [], ...extra }],
  });
}

describe("P6.6 extract contract", () => {
  test("P66-01: prompt 含三类型分节、拆分对照、source_turns、语言规则", async () => {
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain('"items"');
    expect(prompt).toContain("{ \"items\": [] }");
    expect(prompt).toContain("Few-shot");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("Type contracts");
    expect(prompt).toContain("### lesson");
    expect(prompt).toContain("### note");
    expect(prompt).toContain("Split (atomic items)");
    expect(prompt).toContain("source_turns");
    expect(prompt).toContain("same language as the user turns");
    expect(prompt).toContain("上线延期到6月3日");
  });

  test(
    "P66-02: user prompt 含 Session Time 与 Conversation",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-02-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let prompt = "";
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "你好", at: "2026-08-13T12:00:00.000Z" }],
        llm: mockLlm(JSON.stringify({ items: [] }), (req) => {
          prompt = req.prompt;
        }),
      });
      expect(prompt).toContain("Session Time");
      expect(prompt).toContain("2026-08-13 12:00 UTC");
      expect(prompt).toContain("## Conversation");
      expect(prompt).toContain("1. user: 你好");
    },
    T,
  );

  test(
    "P66-03: 先 capture 相关 note → compile prompt 含 Already-in-kb 标题",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "P66PREFETCHTOKENXYZ 已存约定",
        body: "仓里已有 P66PREFETCHTOKENXYZ 这条稳定约定。",
        createdBy: "cli:test",
      });
      let prompt = "";
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "关于 P66PREFETCHTOKENXYZ 我们又聊了一下" }],
        llm: mockLlm(JSON.stringify({ items: [] }), (req) => {
          prompt = req.prompt;
        }),
      });
      expect(prompt).toContain(ALREADY_IN_KB_HEADING);
      expect(prompt).toContain("P66PREFETCHTOKENXYZ 已存约定");
      expect(prompt).not.toContain("brains/default/sources");
    },
    T,
  );

  test(
    "P66-04: prefetch_topn=0 → 不含 Already-in-kb",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, { compile: { prefetch_topn: 0 } });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "P66PREFETCHTOKENXYZ 已存约定",
        body: "仓里已有 P66PREFETCHTOKENXYZ 这条稳定约定。",
        createdBy: "cli:test",
      });
      let prompt = "";
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "关于 P66PREFETCHTOKENXYZ 我们又聊了一下" }],
        llm: mockLlm(JSON.stringify({ items: [] }), (req) => {
          prompt = req.prompt;
        }),
      });
      expect(prompt).not.toContain("Already in the knowledge base");
    },
    T,
  );

  test(
    "P66-05: source_turns 越界 → 该条错误，不写 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-05-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "我们决定改超时" }],
        llm: mockLlm(decisionJson("改超时", "超时改为 3 秒。", { source_turns: [99] })),
      });
      expect(r.kept.length).toBe(0);
      expect(r.errors.some((e) => e.code === ErrorCodes.VALIDATION && e.message.includes("source_turns"))).toBe(true);
    },
    T,
  );

  test(
    "P66-06: source_turns [1] → kept≥1",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "我们决定改超时" }],
        llm: mockLlm(decisionJson("改超时", "超时改为 3 秒。", { source_turns: [1] })),
      });
      expect(r.kept.length).toBeGreaterThanOrEqual(1);
      expect(r.kept[0]!.path).toBeTruthy();
    },
    T,
  );

  test(
    "P66-07: 第一次非 JSON，第二次合法 → kept≥1 且 complete 两次",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let n = 0;
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "我们决定改超时" }],
        llm: mockLlm((req) => {
          n++;
          if (n === 1) return "not-json";
          expect(req.prompt).toContain(JSON_REPAIR_SUFFIX);
          return decisionJson("改超时", "超时改为 3 秒。");
        }),
      });
      expect(n).toBe(2);
      expect(r.kept.length).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "P66-08: 两次皆非 JSON → E_LLM；无新 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-08-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      try {
        await compileSession({
          repoRoot,
          brainId: "default",
          sourceId: "default",
          createdBy: "cli:test",
          pack,
          queue,
          turns: [{ role: "user", text: "我们决定改超时" }],
          llm: mockLlm("not-json"),
        });
        throw new Error("expected throw");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(MemoryError);
        expect((e as MemoryError).code).toBe(ErrorCodes.LLM);
      }
      expect(existsSync(join(repoRoot, "brains", "default", "sources", "default", "issues"))).toBe(true);
    },
    T,
  );

  test("P66-init: memory.yml 含 prefetch_topn: 5", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p66-init-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    expect(yml).toContain("prefetch_topn: 5");
  });
});
