import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  captureNode,
  WriteValidator,
  queryTrend,
  readSchemaSql,
  type Fact,
} from "../src/index.ts";
import type { CreateNodeRequest } from "../src/write/types.ts";
import { ErrorCodes } from "../src/errors.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;
let queue: WriteQueue;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg);
}

function baseReq(overrides: Partial<CreateNodeRequest> = {}): CreateNodeRequest {
  return {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title: "趋势测试",
    body: "正文",
    createdBy: "cli:test",
    ...overrides,
  };
}

function metricFact(at: string, value: number, text = "timeout"): Fact {
  return {
    text,
    event_type: "metric",
    attributed_to: "cli:test",
    at,
    metric: "timeout_ms",
    value,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p95-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
  queue = await makeQueue();
});

describe("P9.5 facts 量纲与 trend", () => {
  test("P95-01 无 metric 的旧 facts capture 仍成功", async () => {
    const rel = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "旧 facts",
      body: "仍合法",
      createdBy: "cli:test",
      facts: [{ text: "决定重试 3 次", event_type: "decision", attributed_to: "user", at: "2026-01-01" }],
    });
    expect(rel).toContain(".md");
  });

  test("P95-02 value 无 metric → E_VALIDATION", async () => {
    const validator = new WriteValidator(repoRoot, pack);
    const result = await validator.validate(
      baseReq({
        facts: [{ text: "缺 metric", event_type: "metric", attributed_to: "cli:test", at: "2026-01-01", value: 5 }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_VALIDATION");

    await expect(
      captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "非法 value",
        body: "正文",
        createdBy: "cli:test",
        facts: [{ text: "缺 metric", event_type: "metric", attributed_to: "cli:test", at: "2026-01-01", value: 3 }],
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION });
  });

  test("P95-03 timeout_ms 5→4 higher_is_better → regressing true", async () => {
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "t1",
      body: "a",
      createdBy: "cli:test",
      facts: [metricFact("2026-01-01", 5)],
    });
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "t2",
      body: "b",
      createdBy: "cli:test",
      facts: [metricFact("2026-02-01", 4)],
    });
    const cfg = await loadRepoConfig(repoRoot);
    const r = await queryTrend(repoRoot, "default", { metric: "timeout_ms" }, cfg.trend);
    expect(r.points.length).toBe(2);
    expect(r.regressing).toBe(true);
    expect(r.drop).toBeCloseTo(0.2, 5);
  });

  test("P95-04 timeout_ms 5→6 → regressing false", async () => {
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "u1",
      body: "a",
      createdBy: "cli:test",
      facts: [metricFact("2026-01-01", 5)],
    });
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "u2",
      body: "b",
      createdBy: "cli:test",
      facts: [metricFact("2026-02-01", 6)],
    });
    const cfg = await loadRepoConfig(repoRoot);
    const r = await queryTrend(repoRoot, "default", { metric: "timeout_ms" }, cfg.trend);
    expect(r.regressing).toBe(false);
    expect(r.drop).toBeLessThan(0);
  });

  test("P95-05 仅一笔 → regressing false, reason insufficient", async () => {
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "solo",
      body: "a",
      createdBy: "cli:test",
      facts: [metricFact("2026-01-01", 5)],
    });
    const cfg = await loadRepoConfig(repoRoot);
    const r = await queryTrend(repoRoot, "default", { metric: "timeout_ms" }, cfg.trend);
    expect(r.points.length).toBe(1);
    expect(r.regressing).toBe(false);
    expect(r.reason).toBe("insufficient");
  });

  test("P95-06 无匹配 metric → points 空、不抛错", async () => {
    const cfg = await loadRepoConfig(repoRoot);
    const r = await queryTrend(repoRoot, "default", { metric: "missing_metric" }, cfg.trend);
    expect(r.points).toEqual([]);
    expect(r.regressing).toBe(false);
  });

  test("P95-07 schema.sql 无 CREATE TABLE facts", async () => {
    const sql = await readSchemaSql();
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+facts/i);
  });
});

describe("P9.5 metric 规范化", () => {
  test("metric 大小写与 trim 匹配", async () => {
    await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "norm",
      body: "a",
      createdBy: "cli:test",
      facts: [
        {
          text: "x",
          event_type: "metric",
          attributed_to: "cli:test",
          at: "2026-01-01",
          metric: "  Timeout_MS ",
          value: 10,
        },
      ],
    });
    const cfg = await loadRepoConfig(repoRoot);
    const r = await queryTrend(repoRoot, "default", { metric: "timeout_ms" }, cfg.trend);
    expect(r.points.length).toBe(1);
  });
});
