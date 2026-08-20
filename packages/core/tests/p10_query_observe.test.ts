/**
 * P10.4 query log latency/evidence + explain query_plan / score_details
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  hybridQueryDetailed,
  collectObserverStats,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 60_000 };
const QUERY_LOG = ".dfmemory/logs/query.jsonl";

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

async function readLastQueryLogLine(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(repoRoot, QUERY_LOG), "utf8");
  const lines = raw.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

async function hybridSearch(q: string, explain = false) {
  const conn = await openPglite(repoRoot);
  try {
    return await hybridQueryDetailed(conn.db, {
      brainId: "default",
      query: q,
      repoRoot,
      explain,
      skipCache: true,
    });
  } finally {
    await conn.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p10q-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P10.4 query observe", () => {
  test(
    "P10Q-01: query log has latency_ms >= 0",
    async () => {
      await capture("重试策略", "改为固定三次重试。");
      await hybridSearch("重试");
      const line = await readLastQueryLogLine();
      expect(typeof line.latency_ms).toBe("number");
      expect((line.latency_ms as number) >= 0).toBe(true);
    },
    T,
  );

  test(
    "P10Q-02: BM25 hit → evidence.keyword >= 1",
    async () => {
      await capture("重试策略", "改为固定三次重试。");
      await hybridSearch("重试");
      const line = await readLastQueryLogLine();
      const ev = line.evidence as { keyword: number; semantic: number; graph: number };
      expect(ev.keyword).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "P10Q-03: collectObserverStats has avg_latency_ms and evidence_share.keyword",
    async () => {
      await capture("观测笔记", "用于 observer 统计。");
      await hybridSearch("观测");
      const stats = await collectObserverStats(repoRoot, "default");
      expect(typeof stats.avg_latency_ms).toBe("number");
      expect(typeof stats.evidence_share.keyword).toBe("number");
    },
    T,
  );

  test(
    "P10Q-04: old log without latency_ms does not crash observer",
    async () => {
      const logPath = join(repoRoot, QUERY_LOG);
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(
        logPath,
        `${JSON.stringify({ at: new Date().toISOString(), query: "legacy", hitCount: 1, avgScore: 0.5 })}\n`,
        "utf8",
      );
      await capture("新笔记", "带 latency 的新查询。");
      await hybridSearch("新笔记");
      const stats = await collectObserverStats(repoRoot, "default");
      expect(stats.query_count).toBeGreaterThanOrEqual(2);
      expect(typeof stats.avg_latency_ms).toBe("number");
      expect(stats.avg_latency_ms).toBeGreaterThanOrEqual(0);
    },
    T,
  );

  test(
    "P10Q-05: explain.query_plan includes fusion:rrf_rescale",
    async () => {
      await capture("融合测试", "测试 query_plan 输出。");
      const { explain } = await hybridSearch("融合", true);
      expect(Array.isArray(explain?.query_plan)).toBe(true);
      expect(explain?.query_plan?.some((s) => s.includes("fusion:rrf_rescale"))).toBe(true);
    },
    T,
  );

  test(
    "P10Q-06: every final hit has score_details.final",
    async () => {
      await capture("分数明细", "score_details 终榜测试。");
      const { hits, explain } = await hybridSearch("分数", true);
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        const detail = explain?.score_details?.find((d) => d.path === h.path);
        expect(typeof detail?.final).toBe("number");
      }
    },
    T,
  );

  test(
    "P10Q-07: searched_directories is string array",
    async () => {
      await capture("目录测试", "searched_directories 数组。");
      const { explain } = await hybridSearch("目录", true);
      expect(Array.isArray(explain?.searched_directories)).toBe(true);
      for (const d of explain?.searched_directories ?? []) {
        expect(typeof d).toBe("string");
      }
    },
    T,
  );

  test(
    "P10Q-09: fusion.rescale and hotness_detail still present",
    async () => {
      await capture("P93回归", "fusion 与 hotness_detail。");
      const { explain } = await hybridSearch("P93", true);
      expect(explain?.fusion?.rescale).toBeDefined();
      expect(explain?.hotness_detail?.mode).toBe("multiply");
    },
    T,
  );
});
