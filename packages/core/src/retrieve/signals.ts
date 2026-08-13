/**
 * P3.1 graph signals：对 top-K 重权（fail-open）。
 * adjacency hub 1.05 / cross-source 1.10 / session diversify 0.95
 */
import type { SqlClient } from "../index/sql.ts";
import type { FusedHit } from "./rrf.ts";

export const SIGNAL_HUB = 1.05;
export const SIGNAL_CROSS_SOURCE = 1.1;
export const SIGNAL_DIVERSIFY = 0.95;

export interface SignalExplain {
  hub: string[];
  crossSource: string[];
  diversified: string[];
}

export interface ApplySignalsResult {
  hits: FusedHit[];
  signals: SignalExplain;
}

function sourcePrefix(path: string): string {
  // brains/{id}/sources/{sourceId}/...
  const parts = path.split("/");
  const si = parts.indexOf("sources");
  if (si >= 0 && parts[si + 1]) return parts[si + 1]!;
  const ei = parts.indexOf("experiences");
  if (ei >= 0) return "_experience";
  return "_other";
}

/**
 * 对融合后的候选施加 graph signals；任一异常跳过该信号。
 */
export async function applyGraphSignals(
  db: SqlClient,
  hits: FusedHit[],
  opts: { brainId: string; topK?: number },
): Promise<ApplySignalsResult> {
  const signals: SignalExplain = { hub: [], crossSource: [], diversified: [] };
  if (hits.length === 0) return { hits, signals };

  const topK = Math.min(opts.topK ?? hits.length, hits.length);
  let working = hits.map((h) => ({ ...h, evidence: [...h.evidence] }));

  try {
    const topPaths = working.slice(0, topK).map((h) => h.path);
    if (topPaths.length >= 2) {
      const ph = topPaths.map((_, i) => `$${i + 2}`).join(", ");
      const edges = await db.query<{ from_path: string; to_ref: string }>(
        `SELECT from_path, to_ref FROM links
         WHERE brain_id = $1 AND from_path IN (${ph}) AND to_ref IN (${ph})`,
        [opts.brainId, ...topPaths],
      );
      const degree = new Map<string, number>();
      for (const e of edges.rows) {
        degree.set(e.from_path, (degree.get(e.from_path) ?? 0) + 1);
        degree.set(e.to_ref, (degree.get(e.to_ref) ?? 0) + 1);
      }
      for (const h of working.slice(0, topK)) {
        if ((degree.get(h.path) ?? 0) >= 2) {
          h.score *= SIGNAL_HUB;
          if (!h.evidence.includes("signal:hub")) h.evidence.push("signal:hub");
          signals.hub.push(h.path);
        }
      }
    }
  } catch {
    /* skip hub */
  }

  try {
    const topPaths = working.slice(0, topK).map((h) => h.path);
    for (const h of working.slice(0, topK)) {
      const inbound = await db.query<{ source: string }>(
        `SELECT DISTINCT source FROM links WHERE brain_id = $1 AND to_ref = $2`,
        [opts.brainId, h.path],
      );
      // also count distinct link.source kinds OR distinct from_path source prefixes
      const fromSources = await db.query<{ from_path: string }>(
        `SELECT from_path FROM links WHERE brain_id = $1 AND (to_ref = $2 OR to_ref = $3)`,
        [opts.brainId, h.path, h.path.split("/").pop() ?? h.path],
      );
      const prefixes = new Set(fromSources.rows.map((r) => sourcePrefix(r.from_path)));
      if (prefixes.size >= 2 || inbound.rows.length >= 2) {
        h.score *= SIGNAL_CROSS_SOURCE;
        if (!h.evidence.includes("signal:cross-source")) h.evidence.push("signal:cross-source");
        signals.crossSource.push(h.path);
      }
    }
  } catch {
    /* skip cross-source */
  }

  try {
    // session diversify：同 source 多条只保留最高，其余 ×0.95
    const bestBySource = new Map<string, string>();
    for (const h of working) {
      const src = sourcePrefix(h.path);
      const prev = bestBySource.get(src);
      if (!prev) {
        bestBySource.set(src, h.path);
        continue;
      }
      const prevHit = working.find((x) => x.path === prev)!;
      if (h.score > prevHit.score) {
        bestBySource.set(src, h.path);
      }
    }
    for (const h of working) {
      const src = sourcePrefix(h.path);
      if (bestBySource.get(src) !== h.path) {
        h.score *= SIGNAL_DIVERSIFY;
        if (!h.evidence.includes("signal:diversify")) h.evidence.push("signal:diversify");
        signals.diversified.push(h.path);
      }
    }
  } catch {
    /* skip diversify */
  }

  working.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits: working, signals };
}

/** 纯函数版（测试夹具）：给定邻接与 source 映射。 */
export function applyGraphSignalsPure(
  hits: FusedHit[],
  opts: {
    /** path → 邻接 path 集合（双向） */
    adjacency: Map<string, Set<string>>;
    /** path → inbound source prefixes */
    inboundSources: Map<string, Set<string>>;
    topK?: number;
  },
): ApplySignalsResult {
  const signals: SignalExplain = { hub: [], crossSource: [], diversified: [] };
  const working = hits.map((h) => ({ ...h, evidence: [...h.evidence] }));
  const topK = Math.min(opts.topK ?? working.length, working.length);

  try {
    for (const h of working.slice(0, topK)) {
      const neighbors = opts.adjacency.get(h.path);
      if (neighbors) {
        const withinTop = [...neighbors].filter((n) =>
          working.slice(0, topK).some((x) => x.path === n),
        );
        if (withinTop.length >= 2) {
          h.score *= SIGNAL_HUB;
          h.evidence.push("signal:hub");
          signals.hub.push(h.path);
        }
      }
    }
  } catch {
    /* skip */
  }

  try {
    for (const h of working.slice(0, topK)) {
      const srcs = opts.inboundSources.get(h.path);
      if (srcs && srcs.size >= 2) {
        h.score *= SIGNAL_CROSS_SOURCE;
        h.evidence.push("signal:cross-source");
        signals.crossSource.push(h.path);
      }
    }
  } catch {
    /* skip */
  }

  try {
    const bestBySource = new Map<string, { path: string; score: number }>();
    for (const h of working) {
      const src = sourcePrefix(h.path);
      const prev = bestBySource.get(src);
      if (!prev || h.score > prev.score) bestBySource.set(src, { path: h.path, score: h.score });
    }
    for (const h of working) {
      const src = sourcePrefix(h.path);
      if (bestBySource.get(src)?.path !== h.path) {
        h.score *= SIGNAL_DIVERSIFY;
        h.evidence.push("signal:diversify");
        signals.diversified.push(h.path);
      }
    }
  } catch {
    /* skip */
  }

  working.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits: working, signals };
}
