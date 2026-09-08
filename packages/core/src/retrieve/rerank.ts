import type { QueryHit } from "./query.ts";
import { bigrams } from "./ngrams.ts";

/**
 * 启发式 local rerank：短语命中 + 标题加权 + ngram 重叠 + 邻近度 + 多证据
 * - 短语/标题/bigram 保留原行为（P9.3 基线）
 * - 多证据：命中 query 词种类数加分（每种 +1.0），替代单一计数
 * - 邻近度：query 词在 title+snippet 共现窗口内的距离加分（窗口越小分越高，topN 内有效）
 * 失败由调用方 fail-open。
 */
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
  // 多证据：distinct query 词种类命中加分
  const terms = q.split(/\s+/).filter(Boolean);
  const uniqueTerms = [...new Set(terms)];
  let distinctHit = 0;
  for (const term of uniqueTerms) {
    if (term && text.includes(term)) distinctHit++;
  }
  if (uniqueTerms.length > 0) {
    s += distinctHit * 1.0;
  }
  // 邻近度：所有 query 词共现时按窗口 span 加分（越近越高）
  if (uniqueTerms.length >= 2 && distinctHit === uniqueTerms.length) {
    const positions = uniqueTerms.map((t) => text.indexOf(t));
    const minPos = Math.min(...positions);
    const maxPos = Math.max(...positions);
    const span = maxPos - minPos;
    if (span <= 10) s += 2;
    else if (span <= 30) s += 1.5;
    else if (span <= 60) s += 1;
    else if (span <= 100) s += 0.5;
    else s += 0.2;
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

/**
 * P14.5 cross-encoder 插槽（本期仅接口，不含权重、不调网络）
 * - 三档：off / local / model（model 仅 tokenmax 生效），默认 off
 * - 缺权重时抛 MemoryError(E_DISABLED)，hybrid 侧降级 local → skipped，--explain 可观测 rerank 状态与贡献
 * - 正式注入点：HybridQueryOptions.rerankFn
 */
export type CrossEncoderRerankFn = (query: string, hits: QueryHit[]) => QueryHit[] | Promise<QueryHit[]>;
