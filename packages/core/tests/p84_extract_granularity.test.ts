/**
 * P8.4 提取粒度：清单合成一条；独立决策仍拆；不破 P6.6
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  compileSession,
  loadSessionExtractPrompt,
  parseSessionTurns,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const FIXTURES = join(import.meta.dir, "fixtures");

const LIST_KEYWORDS = [
  "memory.yml",
  "embedding.provider",
  "git.mode",
  "pglite",
  "brains/default",
  "rebuild-index",
];

const DECISION_ANCHORS = ["固定3次", "30秒"] as const;

type ExtractPayload = { items: Array<{ type: string; title: string; body: string }> };

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

function mockLlm(text: string): LLMProvider {
  return {
    id: "mock",
    async complete(_req: CompleteRequest): Promise<CompleteResult> {
      return { text };
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

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as T;
}

describe("P8.4 extract granularity", () => {
  test("P84-00: 基线 fixture 入库且非空；旧合同清单会碎成 ≥5 条", async () => {
    const listBody = (await readFile(join(FIXTURES, "extract-list-body.md"), "utf8")).trim();
    const dialogue = (await readFile(join(FIXTURES, "extract-dialogue.jsonl"), "utf8")).trim();
    expect(listBody.length).toBeGreaterThan(0);
    expect(dialogue.length).toBeGreaterThan(0);
    expect(listBody).toContain("请记住这些");
    const turns = parseSessionTurns(dialogue);
    expect(turns.length).toBeGreaterThanOrEqual(6);

    const baseline = await loadJson<ExtractPayload>("extract-list-body.baseline.json");
    expect(baseline.items.length).toBeGreaterThanOrEqual(5);
  });

  test("P84-01: 资源含 Granularity 与清单合成约束，且保留 P6.6 合同句", async () => {
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain("Granularity");
    expect(prompt).toContain("清单合成一条");
    expect(prompt).toContain("Split (atomic items)");
    expect(prompt).toContain("source_turns");
    expect(prompt).toContain("{ \"items\": [] }");
    expect(prompt).toContain("path");
    expect(prompt).toContain("[[wikilink]]");
    expect(prompt).toContain("上线延期到6月3日");
  });

  test("P84-05: 说明书含最小信息量 / 禁止单词 note", async () => {
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain("最小信息量");
    expect(prompt).toContain("禁止单词 note");
  });

  test(
    "P84-02: 清单 mock 回放新合同 JSON → items≤2 且 body 覆盖 ≥80% 要点词",
    async () => {
      const expected = await loadJson<ExtractPayload>("extract-list-body.expected.json");
      expect(expected.items.length).toBeLessThanOrEqual(2);
      const blob = expected.items.map((i) => `${i.title}\n${i.body}`).join("\n");
      const hit = LIST_KEYWORDS.filter((k) => blob.includes(k)).length;
      expect(hit / LIST_KEYWORDS.length).toBeGreaterThanOrEqual(0.8);

      const listBody = await readFile(join(FIXTURES, "extract-list-body.md"), "utf8");
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p84-02-"));
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
        turns: [{ role: "user", text: listBody }],
        llm: mockLlm(JSON.stringify({ items: expected.items })),
      });
      expect(r.kept.length).toBeLessThanOrEqual(2);
      expect(r.kept.length).toBe(expected.items.length);
      expect(r.kept[0]!.path).toBeTruthy();
    },
    T,
  );

  test(
    "P84-03: 对话 fixture 两个独立 decision 仍拆条，闲聊不进 note",
    async () => {
      const expected = await loadJson<ExtractPayload>("extract-dialogue.expected.json");
      const decisions = expected.items.filter((i) => i.type === "decision");
      expect(decisions.length).toBe(2);
      for (const anchor of DECISION_ANCHORS) {
        expect(decisions.some((d) => d.title.includes(anchor))).toBe(true);
      }
      expect(expected.items.every((i) => i.type !== "note")).toBe(true);

      const turns = parseSessionTurns(await readFile(join(FIXTURES, "extract-dialogue.jsonl"), "utf8"));
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p84-03-"));
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
        turns,
        llm: mockLlm(JSON.stringify({ items: expected.items })),
      });
      const keptDecisions = r.kept.filter((k) => k.type === "decision");
      expect(keptDecisions.length).toBe(2);
      for (const anchor of DECISION_ANCHORS) {
        expect(keptDecisions.some((k) => k.title.includes(anchor))).toBe(true);
      }
      expect(r.kept.some((k) => k.type === "note")).toBe(false);
    },
    T,
  );
});
