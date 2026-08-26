/**
 * P11.7 L0 capture 审计：memory_diff create + node_created
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  compileSession,
  importNode,
  listMemoryDiffs,
  listLedgerEvents,
  revertMemoryDiff,
  MemoryError,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 180_000 };

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p117-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return { repoRoot, pack, queue };
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

describe("P11.7 L0 audit", () => {
  test(
    "P117-01: captureNode → create + node_created",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "L0 audit note",
        body: "body for audit",
        createdBy: "cli:test",
      });
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.some((d) => d.op === "create" && d.paths_written.includes(path))).toBe(true);
      const evts = await listLedgerEvents(repoRoot, "default", { type: "node_created", limit: 20 });
      expect(evts.some((e) => e.payload?.path === path)).toBe(true);
    },
    T,
  );

  test(
    "P117-02: md / ledger / memory_diff 文件都在",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "files exist",
        body: "x",
        createdBy: "cli:test",
      });
      expect(existsSync(join(repoRoot, path))).toBe(true);
      const diffs = await listMemoryDiffs(repoRoot, "default", 5);
      const create = diffs.find((d) => d.op === "create");
      expect(create).toBeTruthy();
      const month = (create!.at ?? "").slice(0, 7);
      expect(existsSync(join(repoRoot, "brains", "default", "events", month, "ledger.jsonl"))).toBe(true);
      expect(existsSync(join(repoRoot, "brains", "default", "events", month, "memory_diff.jsonl"))).toBe(true);
    },
    T,
  );

  test(
    "P117-03: compile 两条 L0 → 两条 create + 两条 node_created",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const json = JSON.stringify({
        items: [
          { type: "decision", title: "Audit compile A unique xyz", body: "compile body a unique xyz", mentions: [] },
          { type: "decision", title: "Audit compile B unique uvw", body: "compile body b unique uvw", mentions: [] },
        ],
      });
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "记下两件独立决定" }],
        llm: mockLlm(json),
      });
      expect(r.errors).toEqual([]);
      expect(r.kept.length).toBeGreaterThanOrEqual(2);
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.filter((d) => d.op === "create").length).toBeGreaterThanOrEqual(2);
      const evts = await listLedgerEvents(repoRoot, "default", { type: "node_created", limit: 20 });
      expect(evts.length).toBeGreaterThanOrEqual(2);
    },
    T,
  );

  test(
    "P117-04: 非法 capture 不写幽灵审计",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      await expect(
        captureNode(repoRoot, pack, queue, {
          brainId: "default",
          sourceId: "default",
          schemaType: "note",
          title: "",
          body: "no",
          createdBy: "cli:test",
        }),
      ).rejects.toBeInstanceOf(MemoryError);
      expect(await listMemoryDiffs(repoRoot, "default", 20)).toEqual([]);
      expect(await listLedgerEvents(repoRoot, "default", { type: "node_created", limit: 20 })).toEqual([]);
    },
    T,
  );

  test(
    "P117-05: importNode 同样写 create + node_created",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const src = join(repoRoot, "import-me.md");
      await writeFile(
        src,
        `---
title: Imported note
schema_type: note
source: default
---
## 摘要

imported body

## 正文
imported body
`,
        "utf8",
      );
      const path = await importNode(repoRoot, pack, queue, src, {
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
      });
      const diffs = await listMemoryDiffs(repoRoot, "default", 20);
      expect(diffs.some((d) => d.op === "create" && d.paths_written.includes(path))).toBe(true);
      const evts = await listLedgerEvents(repoRoot, "default", { type: "node_created", limit: 20 });
      expect(evts.some((e) => e.payload?.path === path)).toBe(true);
    },
    T,
  );

  test(
    "P117 revert create 仍 unsupported 且不删 md",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "revert create stays",
        body: "keep this file",
        createdBy: "cli:test",
      });
      const create = (await listMemoryDiffs(repoRoot, "default", 5)).find((d) => d.op === "create");
      expect(create).toBeTruthy();
      const rev = await revertMemoryDiff(repoRoot, "default", create!.id, queue);
      expect(rev.ok).toBe(false);
      expect(rev.reason).toBe("unsupported_op");
      expect(existsSync(join(repoRoot, path))).toBe(true);
    },
    T,
  );
});
