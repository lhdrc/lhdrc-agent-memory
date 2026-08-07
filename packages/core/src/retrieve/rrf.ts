/**
 * P2.1a 臂内 RRF + 臂间加权融合（无图臂冻结公式）。
 * 权威：specs/二期/P2.1a-hybrid-retrieval.md §5
 */

export const RRF_K = 60;

export type SearchMode = "conservative" | "balanced" | "tokenmax";

export interface RankedHit {
  path: string;
  /** 臂内原始分（可选，仅透传） */
  score?: number;
  title?: string;
  snippet?: string;
  evidence?: string[];
}

export interface FusedHit {
  path: string;
  score: number;
  rrfBm25: number;
  rrfSemantic: number;
  titlePathBoost: number;
  evidence: string[];
  title?: string;
  snippet?: string;
}

/** 臂内：按输入顺序 rank=1..n，同 path max-pool Σ 1/(k+rank) */
export function armRrfScores(hits: RankedHit[], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  hits.forEach((h, i) => {
    const rank = i + 1;
    const contrib = 1 / (k + rank);
    const prev = scores.get(h.path) ?? 0;
    if (contrib > prev) scores.set(h.path, contrib);
  });
  return scores;
}

/**
 * 标题/路径 boost ∈ [0,1]：
 * 标题命中 0.7，路径命中 0.3，可叠加 cap 1。
 */
export function titlePathBoostNorm(query: string, path: string, title: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let boost = 0;
  if (title.toLowerCase().includes(q)) boost += 0.7;
  if (path.toLowerCase().includes(q)) boost += 0.3;
  return Math.min(1, boost);
}

export interface FuseOptions {
  mode: SearchMode;
  query: string;
  /** path → title（缺省用 path basename 逻辑由调用方填） */
  titles: Map<string, string>;
  /** 透传 snippet / 原始 evidence */
  meta?: Map<string, { snippet?: string; title?: string; evidence?: string[] }>;
  limit?: number;
  /** semantic 不可用时视为 conservative */
  semanticAvailable?: boolean;
}

/**
 * balanced: 0.45*rrf(bm25)+0.45*rrf(semantic)+0.10*title_path_boost_norm
 * conservative / semantic 不可用: bm25 RRF + title/path（语义权 0）；最终分归一到同尺度
 * tokenmax（本 Spec 最小）: 同 balanced（扩写/rerank stub）
 */
export function fuseHybridArms(
  bm25Hits: RankedHit[],
  semanticHits: RankedHit[],
  opts: FuseOptions,
): FusedHit[] {
  const limit = opts.limit ?? 10;
  const semanticOn =
    opts.semanticAvailable !== false &&
    opts.mode !== "conservative" &&
    semanticHits.length > 0;

  const effectiveMode: SearchMode =
    opts.mode === "tokenmax" ? "balanced" : opts.mode === "conservative" || !semanticOn ? "conservative" : "balanced";

  const rrfBm25 = armRrfScores(bm25Hits);
  const rrfSem = semanticOn ? armRrfScores(semanticHits) : new Map<string, number>();

  const paths = new Set<string>([...rrfBm25.keys(), ...rrfSem.keys()]);
  // 也纳入仅有 title 命中但未进臂的 path？规格：从两臂出发；title boost 只对候选加分
  for (const h of bm25Hits) paths.add(h.path);
  for (const h of semanticHits) paths.add(h.path);

  const fused: FusedHit[] = [];
  for (const path of paths) {
    const b = rrfBm25.get(path) ?? 0;
    const s = rrfSem.get(path) ?? 0;
    const title = opts.titles.get(path) ?? opts.meta?.get(path)?.title ?? "";
    const tp = titlePathBoostNorm(opts.query, path, title);

    let score: number;
    if (effectiveMode === "conservative") {
      // 加强版 M3：以 bm25 RRF 为主，叠加 title/path（权重合计与 balanced 可比）
      score = 0.9 * b + 0.1 * tp;
    } else {
      score = 0.45 * b + 0.45 * s + 0.1 * tp;
    }

    const evidence = new Set<string>();
    if (b > 0) evidence.add("keyword");
    if (s > 0) evidence.add("semantic");
    if (tp >= 0.7) evidence.add("title");
    else if (tp > 0) evidence.add("path");
    for (const e of opts.meta?.get(path)?.evidence ?? []) evidence.add(e);

    fused.push({
      path,
      score,
      rrfBm25: b,
      rrfSemantic: s,
      titlePathBoost: tp,
      evidence: [...evidence],
      title: title || opts.meta?.get(path)?.title,
      snippet: opts.meta?.get(path)?.snippet,
    });
  }

  fused.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // 同 path 已唯一；再 max-pool 保险
  const seen = new Set<string>();
  const out: FusedHit[] = [];
  for (const h of fused) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
