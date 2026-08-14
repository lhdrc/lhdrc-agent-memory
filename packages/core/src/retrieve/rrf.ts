/**
 * P2.1a 臂内 RRF + 臂间加权融合；P3.1 扩展 graph / entity 臂。
 * 权威：specs/二期/P2.1a-hybrid-retrieval.md §5；specs/三期/P3.1-graph-signals.md §7
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
  rrfGraph: number;
  titlePathBoost: number;
  entityBoost: number;
  evidence: string[];
  title?: string;
  snippet?: string;
}

/** P3.1 含 graph 的 balanced 默认权重（冻结） */
export interface FusionWeights {
  wKw: number;
  wSem: number;
  wGraph: number;
  wTitle: number;
  wEntity: number;
}

/** balanced + graph + semantic（general/task 冻结） */
export const WEIGHTS_BALANCED_GRAPH: FusionWeights = {
  wKw: 0.35,
  wSem: 0.2,
  wGraph: 0.2,
  wTitle: 0.1,
  wEntity: 0.15,
};

/** relation 意图：抬高 w_graph（语义开） */
export const WEIGHTS_RELATION: FusionWeights = {
  wKw: 0.2,
  wSem: 0.15,
  wGraph: 0.45,
  wTitle: 0.1,
  wEntity: 0.1,
};

/** person 意图：抬高 entity */
export const WEIGHTS_PERSON: FusionWeights = {
  wKw: 0.25,
  wSem: 0.15,
  wGraph: 0.15,
  wTitle: 0.1,
  wEntity: 0.35,
};

/** experience 意图：仍走图融合；/experiences/ 路径 boost 在 fuseHybridArms 侧另加 */
export const WEIGHTS_EXPERIENCE: FusionWeights = {
  wKw: 0.3,
  wSem: 0.25,
  wGraph: 0.15,
  wTitle: 0.15,
  wEntity: 0.15,
};

/** 无语义 general/task（对齐 08 §7.2 kw/graph；hotness 在 hybrid 后乘） */
export const WEIGHTS_NO_SEMANTIC: FusionWeights = {
  wKw: 0.55,
  wSem: 0,
  wGraph: 0.3,
  wTitle: 0.1,
  wEntity: 0.05,
};

/** relation + 无语义（08 relation graph=0.55） */
export const WEIGHTS_RELATION_NO_SEM: FusionWeights = {
  wKw: 0.3,
  wSem: 0,
  wGraph: 0.55,
  wTitle: 0.1,
  wEntity: 0.05,
};

export type IntentForWeights = "task" | "experience" | "person" | "relation" | "general";

export function resolveFusionWeights(
  intent: IntentForWeights,
  semanticOn: boolean,
): FusionWeights {
  if (!semanticOn) {
    return intent === "relation"
      ? { ...WEIGHTS_RELATION_NO_SEM }
      : { ...WEIGHTS_NO_SEMANTIC };
  }
  switch (intent) {
    case "relation":
      return { ...WEIGHTS_RELATION };
    case "person":
      return { ...WEIGHTS_PERSON };
    case "experience":
      return { ...WEIGHTS_EXPERIENCE };
    default:
      return { ...WEIGHTS_BALANCED_GRAPH };
  }
}

export function weightsKey(w: FusionWeights): string {
  return `kw${w.wKw}_sem${w.wSem}_g${w.wGraph}_t${w.wTitle}_e${w.wEntity}`;
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
  /**
   * P3.1：传入则启用含 graph 的融合公式；
   * 不传则保持 P2.1a 无图冻结公式（回归兼容）。
   */
  graphHits?: RankedHit[];
  /** path → entity_boost_norm ∈ [0,1] */
  entityBoosts?: Map<string, number>;
  intent?: IntentForWeights;
  /** 显式权重（测试夹具） */
  weights?: FusionWeights;
}

/**
 * P2.1a（无 graphHits）:
 *   balanced: 0.45*rrf(bm25)+0.45*rrf(semantic)+0.10*title_path_boost_norm
 *   conservative / semantic 不可用: 0.9*bm25 + 0.1*title
 *
 * P3.1（有 graphHits，含空数组）:
 *   final = w_kw*rrf(bm25)+w_sem*rrf(sem)+w_graph*rrf(graph)
 *         + w_title*title + w_entity*entity
 */
export function fuseHybridArms(
  bm25Hits: RankedHit[],
  semanticHits: RankedHit[],
  opts: FuseOptions,
): FusedHit[] {
  const limit = opts.limit ?? 10;
  const useGraphFormula = opts.graphHits !== undefined;

  const semanticOn =
    opts.semanticAvailable !== false &&
    opts.mode !== "conservative" &&
    semanticHits.length > 0;

  const rrfBm25 = armRrfScores(bm25Hits);
  const rrfSem = semanticOn ? armRrfScores(semanticHits) : new Map<string, number>();
  const rrfGraph =
    useGraphFormula && opts.graphHits && opts.graphHits.length > 0
      ? armRrfScores(opts.graphHits)
      : new Map<string, number>();

  const paths = new Set<string>([...rrfBm25.keys(), ...rrfSem.keys(), ...rrfGraph.keys()]);
  for (const h of bm25Hits) paths.add(h.path);
  for (const h of semanticHits) paths.add(h.path);
  if (opts.graphHits) for (const h of opts.graphHits) paths.add(h.path);

  const intent = opts.intent ?? "general";
  const weights =
    opts.weights ??
    (useGraphFormula
      ? resolveFusionWeights(intent, semanticOn && opts.mode !== "conservative")
      : null);

  const fused: FusedHit[] = [];
  for (const path of paths) {
    const b = rrfBm25.get(path) ?? 0;
    const s = rrfSem.get(path) ?? 0;
    const g = rrfGraph.get(path) ?? 0;
    const title = opts.titles.get(path) ?? opts.meta?.get(path)?.title ?? "";
    const tp = titlePathBoostNorm(opts.query, path, title);
    let entity = opts.entityBoosts?.get(path) ?? 0;
    if (intent === "experience" && path.includes("/experiences/")) {
      entity = Math.min(1, entity + 0.3);
    }

    let score: number;
    if (!useGraphFormula || !weights) {
      const effectiveMode: SearchMode =
        opts.mode === "tokenmax"
          ? "balanced"
          : opts.mode === "conservative" || !semanticOn
            ? "conservative"
            : "balanced";
      if (effectiveMode === "conservative") {
        score = 0.9 * b + 0.1 * tp;
      } else {
        score = 0.45 * b + 0.45 * s + 0.1 * tp;
      }
    } else if (opts.mode === "conservative") {
      score = 0.75 * b + 0.15 * g + 0.05 * tp + 0.05 * entity;
    } else {
      score =
        weights.wKw * b +
        weights.wSem * s +
        weights.wGraph * g +
        weights.wTitle * tp +
        weights.wEntity * entity;
    }

    const evidence = new Set<string>();
    if (b > 0) evidence.add("keyword");
    if (s > 0) evidence.add("semantic");
    if (g > 0) evidence.add("graph");
    if (entity > 0) evidence.add("entity");
    if (tp >= 0.7) evidence.add("title");
    else if (tp > 0) evidence.add("path");
    for (const e of opts.meta?.get(path)?.evidence ?? []) evidence.add(e);

    fused.push({
      path,
      score,
      rrfBm25: b,
      rrfSemantic: s,
      rrfGraph: g,
      titlePathBoost: tp,
      entityBoost: entity,
      evidence: [...evidence],
      title: title || opts.meta?.get(path)?.title,
      snippet: opts.meta?.get(path)?.snippet,
    });
  }

  fused.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
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
