import type { QueryHit } from "./query.ts";
import { bigrams } from "./ngrams.ts";

/** 启发式 local rerank：短语命中 + ngram 重叠。失败由调用方 fail-open。 */
export function localRerankScore(query: string, title: string, snippet: string): number {
  const q = query.trim().toLowerCase();
  const text = `${title} ${snippet}`.toLowerCase();
  if (!q || !text.trim()) return 0;
  let s = 0;
  if (text.includes(q)) s += 3;
  if (title.toLowerCase().includes(q)) s += 2;
  const ng = bigrams(q).split(/\s+/).filter(Boolean);
  for (const g of ng) {
    if (text.includes(g)) s += 0.5;
  }
  return s;
}

export function localRerank(query: string, hits: QueryHit[], topN: number): QueryHit[] {
  const n = Math.max(1, topN);
  const head = hits.slice(0, n);
  const rest = hits.slice(n);
  const scored = head.map((h) => ({
    hit: h,
    rs: localRerankScore(query, h.title, h.snippet),
  }));
  scored.sort((a, b) => b.rs - a.rs || b.hit.score - a.hit.score || a.hit.path.localeCompare(b.hit.path));
  return [...scored.map((x) => x.hit), ...rest];
}

export type RerankStatus = "local" | "off" | "model" | "skipped";
