/**
 * P9.9 — distill reads pack merge_op for experience merge only.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  writeExperience,
  sha256Hex,
  parseFrontmatter,
  MemoryError,
  type LLMProvider,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type CompleteResult,
  type SchemaPack,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: SchemaPack;

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

function packWithExperienceMergeOp(op: string): SchemaPack {
  return { ...pack, merge_op: { ...pack.merge_op, experience: op } };
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
      trigger: this.exp?.trigger ?? "new-trigger-value",
      procedure: this.exp?.procedure ?? "NEW_PROCEDURE_SEGMENT",
      boundary: this.exp?.boundary ?? "NEW_BOUNDARY_SEGMENT",
      body: this.exp?.body ?? "\n## Merged\nnew body segment",
    };
  }

  async complete(): Promise<CompleteResult> {
    return { text: JSON.stringify({ items: [] }) };
  }
}

const mergeDecision = (targetExpId: string): DistillDecision => ({
  candidate: "none",
  item: "merge",
  targetExpId,
  confidence: 0.9,
  rationale: "merge into existing",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p99-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P9.9 merge_op (experience distill)", () => {
  test(
    "P99-01: experience append → old procedure kept, new segment appended",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const queue = await makeQueue();
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "旧重试经验",
        trigger: "old-trigger",
        procedure: "OLD_PROCEDURE_KEEP",
        boundary: "old-boundary",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expappend1",
      });

      const llm = new FakeLLM(mergeDecision("expappend1"));
      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
        pack: packWithExperienceMergeOp("append"),
      });

      expect(result.written).toBe(1);
      expect(result.paths![0]).toBe(expPath);

      const { data } = parseFrontmatter(await readFile(join(repoRoot, expPath), "utf8"));
      const procedure = String(data.procedure ?? "");
      expect(procedure).toContain("OLD_PROCEDURE_KEEP");
      expect(procedure).toContain("NEW_PROCEDURE_SEGMENT");
      expect(procedure.indexOf("OLD_PROCEDURE_KEEP")).toBeLessThan(procedure.indexOf("NEW_PROCEDURE_SEGMENT"));
    },
    T,
  );

  test(
    "P99-02: experience patch → specified fields replaced",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const queue = await makeQueue();
      const expPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "旧重试经验",
        trigger: "old-trigger",
        procedure: "OLD_PROCEDURE_GONE",
        boundary: "OLD_BOUNDARY_GONE",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "exppatch01",
        body: "OLD_BODY_GONE",
      });

      const llm = new FakeLLM(mergeDecision("exppatch01"));
      await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
        pack: packWithExperienceMergeOp("patch"),
      });

      const merged = parseFrontmatter(await readFile(join(repoRoot, expPath), "utf8"));
      expect(String(merged.data.procedure)).toBe("NEW_PROCEDURE_SEGMENT");
      expect(String(merged.data.procedure)).not.toContain("OLD_PROCEDURE_GONE");
      expect(String(merged.data.boundary)).toBe("NEW_BOUNDARY_SEGMENT");
      expect(String(merged.data.boundary)).not.toContain("OLD_BOUNDARY_GONE");
      expect(String(merged.data.trigger)).toBe("new-trigger-value");
      expect(merged.body).toContain("new body segment");
      expect(merged.body).not.toContain("OLD_BODY_GONE");
    },
    T,
  );

  test(
    "P99-03: experience immutable + LLM merge → old file unchanged, new experience created",
    async () => {
      const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
      const queue = await makeQueue();
      const oldExpPath = await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "不可变旧经验",
        trigger: "immutable-trigger",
        procedure: "IMMUTABLE_OLD_PROCEDURE",
        boundary: "immutable-boundary",
        sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
        id: "expimmut01",
        body: "immutable old body",
      });

      const oldHash = sha256Hex(await readFile(join(repoRoot, oldExpPath), "utf8"));
      const llm = new FakeLLM(mergeDecision("expimmut01"));
      const result = await refineSource(repoRoot, {
        brainId: "default",
        path: sourceRel,
        queue,
        llm,
        pack: packWithExperienceMergeOp("immutable"),
      });

      expect(result.written).toBe(1);
      expect(result.paths![0]).not.toBe(oldExpPath);

      const oldHashAfter = sha256Hex(await readFile(join(repoRoot, oldExpPath), "utf8"));
      expect(oldHashAfter).toBe(oldHash);

      const oldRaw = await readFile(join(repoRoot, oldExpPath), "utf8");
      expect(oldRaw).toContain("IMMUTABLE_OLD_PROCEDURE");
      expect(oldRaw).not.toContain("NEW_PROCEDURE_SEGMENT");

      const newPath = result.paths![0]!;
      expect(existsSync(join(repoRoot, newPath))).toBe(true);
      const newRaw = await readFile(join(repoRoot, newPath), "utf8");
      expect(newRaw).toContain("schema_type: experience");
      expect(newRaw).toContain("NEW_PROCEDURE_SEGMENT");

      const expDir = join(repoRoot, "brains", "default", "experiences");
      const files = (await readdir(expDir)).filter((f) => f.endsWith(".md"));
      expect(files.length).toBe(2);
    },
    T,
  );

  test(
    "P99-04: manual capture note does not rewrite existing note even if note: patch",
    async () => {
      const testPack = packWithExperienceMergeOp("append");
      expect(testPack.merge_op.note).toBe("patch");

      const queue = await makeQueue();
      const path1 = await captureNode(repoRoot, testPack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Dup note title",
        body: "FIRST_NOTE_BODY_KEEP",
        createdBy: "cli:test",
      });

      const hashBefore = sha256Hex(await readFile(join(repoRoot, path1), "utf8"));

      await expect(
        captureNode(repoRoot, testPack, queue, {
          brainId: "default",
          sourceId: "default",
          schemaType: "note",
          title: "Dup note title",
          body: "SECOND_NOTE_BODY_MUST_NOT_APPEAR",
          createdBy: "cli:test",
        }),
      ).rejects.toBeInstanceOf(MemoryError);

      const hashAfter = sha256Hex(await readFile(join(repoRoot, path1), "utf8"));
      expect(hashAfter).toBe(hashBefore);

      const raw = await readFile(join(repoRoot, path1), "utf8");
      expect(raw).toContain("FIRST_NOTE_BODY_KEEP");
      expect(raw).not.toContain("SECOND_NOTE_BODY_MUST_NOT_APPEAR");
    },
    T,
  );

  test(
    "P99-05: unknown merge_op string → treated as append, refine succeeds",
    async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const sourceRel = await capture("重试策略", "网关超时改为固定重试 3 次。");
        const queue = await makeQueue();
        const expPath = await writeExperience(repoRoot, pack, queue, {
          brainId: "default",
          title: "未知 op 经验",
          trigger: "t",
          procedure: "BASE_PROCEDURE",
          boundary: "b",
          sourcePaths: [sourceRel.replace(/^brains\/default\//, "")],
          id: "expunknown",
        });

        const llm = new FakeLLM(mergeDecision("expunknown"));
        const result = await refineSource(repoRoot, {
          brainId: "default",
          path: sourceRel,
          queue,
          llm,
          pack: packWithExperienceMergeOp("totally-invalid-op"),
        });

        expect(result.written).toBe(1);
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("totally-invalid-op"))).toBe(true);

        const { data } = parseFrontmatter(await readFile(join(repoRoot, expPath), "utf8"));
        const procedure = String(data.procedure ?? "");
        expect(procedure).toContain("BASE_PROCEDURE");
        expect(procedure).toContain("NEW_PROCEDURE_SEGMENT");
      } finally {
        warnSpy.mockRestore();
      }
    },
    T,
  );
});
