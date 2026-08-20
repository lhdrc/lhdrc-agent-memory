/**
 * P3.2 observer：聚合 query/distill/cost 指标。
 */
import { existsSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { mkdirp } from "../util/fs.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { readCostConfig, readCostLog } from "../cost/logger.ts";

export interface QueryEvidenceCounts {
  keyword: number;
  semantic: number;
  graph: number;
}

export interface ObserverStats {
  query_count: number;
  zero_result_rate: number;
  avg_score: number;
  avg_latency_ms: number;
  evidence_share: QueryEvidenceCounts;
  distill_count: number;
  cost: {
    entries: number;
    tokens_in: number;
    tokens_out: number;
    skipped: number;
  };
}

const QUERY_LOG = ".dfmemory/logs/query.jsonl";

export async function recordQueryStat(
  repoRoot: string,
  entry: {
    query: string;
    hitCount: number;
    avgScore: number;
    at?: string;
    latency_ms?: number;
    evidence?: QueryEvidenceCounts;
  },
): Promise<void> {
  const abs = join(repoRoot, QUERY_LOG);
  await mkdirp(dirname(abs));
  const row: Record<string, unknown> = {
    at: entry.at ?? new Date().toISOString(),
    query: entry.query,
    hitCount: entry.hitCount,
    avgScore: entry.avgScore,
  };
  if (entry.latency_ms !== undefined) row.latency_ms = entry.latency_ms;
  if (entry.evidence) row.evidence = entry.evidence;
  await appendFile(abs, `${JSON.stringify(row)}\n`, "utf8");
}

export async function collectObserverStats(repoRoot: string, brainId: string): Promise<ObserverStats> {
  const cfg = await loadRepoConfig(repoRoot);
  const costCfg = readCostConfig(cfg);

  let query_count = 0;
  let zero = 0;
  let scoreSum = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let evKeyword = 0;
  let evSemantic = 0;
  let evGraph = 0;

  const qAbs = join(repoRoot, QUERY_LOG);
  if (existsSync(qAbs)) {
    const raw = await readFile(qAbs, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as {
          hitCount: number;
          avgScore: number;
          latency_ms?: number;
          evidence?: Partial<QueryEvidenceCounts>;
        };
        query_count++;
        if (!e.hitCount) zero++;
        scoreSum += e.avgScore ?? 0;
        if (typeof e.latency_ms === "number" && Number.isFinite(e.latency_ms)) {
          latencySum += e.latency_ms;
          latencyCount++;
        }
        if (e.evidence) {
          evKeyword += e.evidence.keyword ?? 0;
          evSemantic += e.evidence.semantic ?? 0;
          evGraph += e.evidence.graph ?? 0;
        }
      } catch {
        /* skip */
      }
    }
  }

  let distill_count = 0;
  const eventsDir = join(repoRoot, "brains", brainId, "events");
  if (existsSync(eventsDir)) {
    const { readdir } = await import("node:fs/promises");
    const months = await readdir(eventsDir);
    for (const m of months) {
      const file = join(eventsDir, m, "memory_diff.jsonl");
      if (!existsSync(file)) continue;
      const raw = await readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { op: string };
          if (e.op?.startsWith("experience_") || e.op === "abstract_update") distill_count++;
        } catch {
          /* skip */
        }
      }
    }
  }

  const costs = await readCostLog(repoRoot, costCfg);
  let tokens_in = 0;
  let tokens_out = 0;
  let skipped = 0;
  for (const c of costs) {
    if (c.skipped) skipped++;
    else {
      tokens_in += c.tokens_in ?? 0;
      tokens_out += c.tokens_out ?? 0;
    }
  }

  const evSum = evKeyword + evSemantic + evGraph;
  const evidence_share: QueryEvidenceCounts = evSum
    ? {
        keyword: evKeyword / evSum,
        semantic: evSemantic / evSum,
        graph: evGraph / evSum,
      }
    : { keyword: 0, semantic: 0, graph: 0 };

  return {
    query_count,
    zero_result_rate: query_count ? zero / query_count : 0,
    avg_score: query_count ? scoreSum / query_count : 0,
    avg_latency_ms: latencyCount ? latencySum / latencyCount : 0,
    evidence_share,
    distill_count,
    cost: { entries: costs.length, tokens_in, tokens_out, skipped },
  };
}
