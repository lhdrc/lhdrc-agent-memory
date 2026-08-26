import type { SqlClient } from "../index/sql.ts";
import type { EmbeddingProvider, SearchConfig } from "../embed/types.ts";
import { DEFAULT_SEARCH_CONFIG, DEFAULT_FUSION_CONFIG } from "../embed/types.ts";
import { readEmbeddingMeta } from "../index/meta.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { bm25Query, type QueryHit, type QueryOptions, assertExclusiveSchemaFilters } from "./query.ts";
import { fuseHybridArms, resolveFusionWeights, weightsKey, sortWithTieBreak, type RankedHit, type SearchMode, type FusedHit } from "./rrf.ts";
import { semanticArm } from "./semantic.ts";
import { classifyIntent, scopePrefixForIntent, type QueryIntent, type ScopeRoute } from "./intent.ts";
import { graphArmDetailed, type GraphMode } from "./graph.ts";
import { applyGraphSignals, type SignalExplain } from "./signals.ts";
import { getSearchCache, setSearchCache, knobsHash, type SearchKnobs } from "./cache.ts";
import { heuristicExpand } from "./expand.ts";
import { localRerank, localRerankScore, type RerankStatus } from "./rerank.ts";
import { applyHotness, hotnessBoost, freqFromHitCount } from "./hotness.ts";
import { applyDirectoryPrefilter, type DirectoryPrefilterExplain } from "./prefilter.ts";
import { annotateHits } from "./annotate.ts";
import { applyStaleDemote, loadCrossFilePairs, type StaleDemoteExplain } from "./stale.ts";
import { recordQueryStat, type QueryEvidenceCounts } from "../observer/stats.ts";
import { bumpHitCounts, readHitCounts } from "../observer/hit-counts.ts";

export interface HybridQueryOptions extends QueryOptions {
  mode?: SearchMode;
  embedder?: EmbeddingProvider | null;
  schemaType?: string;
  repoRoot?: string;
  intentLexicon?: Record<string, string[]> | null;
  skipCache?: boolean;
  explain?: boolean;
  search?: SearchConfig;
  /** P11.1：单次覆盖仓配置 */
  scopeFirst?: boolean;
  /** 内部：范围选择已处理，避免递归 */
  scopePass?: boolean;
  /** 内部：窄搜不写 query log */
  omitQueryStat?: boolean;
  /** 测试注入；throw 时 rerank=skipped */
  rerankFn?: (query: string, hits: QueryHit[]) => QueryHit[] | Promise<QueryHit[]>;
}

export interface QueryExplain {
  intent: QueryIntent;
  mode: SearchMode;
  cacheHit: boolean;
  knobsHash: string;
  arms: {
    bm25: Array<{ path: string; rank: number }>;
    semantic: Array<{ path: string; rank: number }>;
    graph: Array<{ path: string; rank: number }>;
  };
  signals: SignalExplain;
  weightsKey: string;
  /** P5.3 */
  queries?: string[];
  rerank?: RerankStatus;
  entity_boosts?: Array<{ path: string; slug: string }>;
  alias_hits?: string[];
  title_phrase?: boolean;
  hotness?: boolean;
  directory_prefilter?: DirectoryPrefilterExplain | null;
  rerank_scores?: Array<{ path: string; score: number }>;
  /** P7.4 */
  graph_mode?: GraphMode;
  /** P9.2：openai/onnx 缺依赖时 fail-open 哈希 */
  embedding_fallback?: "local";
  /** P9.3 */
  fusion?: {
    rescale: boolean;
    per_arm_min: number;
    fused_min: number;
    cosine: "applied" | "skipped";
  };
  hotness_detail?: { alpha: number; mode: "multiply"; freq?: "applied" | "identity"; active_count?: number };
  /** P10.4 */
  query_plan?: string[];
  searched_directories?: string[];
  stale_demote?: StaleDemoteExplain[];
  score_details?: Array<{
    path: string;
    kw?: number;
    sem?: number;
    graph?: number;
    title?: number;
    entity?: number;
    fused?: number;
    cosine?: number;
    hotness?: number;
    final?: number;
    dropped?: "per_arm" | "fused_min" | null;
  }>;
}

export interface HybridQueryResult {
  hits: QueryHit[];
  explain?: QueryExplain;
}

function embeddingMetaMismatch(
  stored: { provider: string; dims: number } | null,
  embedder: EmbeddingProvider,
): boolean {
  if (!stored) return false;
  return stored.provider !== embedder.id || stored.dims !== embedder.dims;
}

function armRanks(hits: RankedHit[]): Array<{ path: string; rank: number }> {
  return hits.map((h, i) => ({ path: h.path, rank: i + 1 }));
}

function advKey(s: SearchConfig): string {
  return `e${s.tokenmax.expand ? 1 : 0}_r${s.tokenmax.rerank}_h${s.hotness.enabled ? 1 : 0}_d${s.directory_prefilter ? 1 : 0}`;
}

function buildKnobs(
  opts: HybridQueryOptions,
  intent: QueryIntent,
  mode: SearchMode,
  limit: number,
  semanticAvailable: boolean,
  search: SearchConfig,
): SearchKnobs {
  const semOn = semanticAvailable && mode !== "conservative";
  return {
    mode,
    brainId: opts.brainId,
    intent,
    sourceId: opts.sourceId,
    schemaType: opts.schemaType,
    excludeSchemaTypes: opts.excludeSchemaTypes,
    excludeSidecars: opts.excludeSidecars,
    weightsKey: weightsKey(resolveFusionWeights(intent, semOn)),
    limit,
    semanticAvailable: semOn,
    advKey: advKey(search),
    pathPrefix: opts.pathPrefix,
    pathContains: opts.pathContains,
  };
}

function mergeBm25Groups(groups: QueryHit[][]): QueryHit[] {
  if (groups.length <= 1) return groups[0] ?? [];
  const best = new Map<string, QueryHit>();
  const rrf = new Map<string, number>();
  for (const g of groups) {
    g.forEach((h, i) => {
      const contrib = 1 / (60 + i + 1);
      rrf.set(h.path, (rrf.get(h.path) ?? 0) + contrib);
      const prev = best.get(h.path);
      if (!prev || h.score > prev.score) best.set(h.path, h);
    });
  }
  return [...best.values()]
    .map((h) => ({ ...h, score: rrf.get(h.path) ?? h.score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function titlePhraseHit(query: string, title: string): boolean {
  const q = query.trim();
  return q.length >= 2 && title.includes(q);
}

function parentDir(path: string): string {
  const posix = path.replace(/\\/g, "/");
  const i = posix.lastIndexOf("/");
  return i < 0 ? posix : posix.slice(0, i);
}

function countEvidenceFromHits(hits: QueryHit[]): QueryEvidenceCounts {
  const ev: QueryEvidenceCounts = { keyword: 0, semantic: 0, graph: 0 };
  for (const h of hits) {
    for (const e of h.evidence) {
      const lower = e.toLowerCase();
      if (lower.includes("bm25") || lower.includes("keyword")) ev.keyword++;
      if (lower.includes("semantic")) ev.semantic++;
      if (lower.includes("graph")) ev.graph++;
    }
  }
  return ev;
}

function searchedDirsFromPrefilter(hits: Array<{ path: string; score: number }>): string[] {
  const dirScore = new Map<string, number>();
  for (const h of hits) {
    const d = parentDir(h.path);
    dirScore.set(d, (dirScore.get(d) ?? 0) + h.score);
  }
  return [...dirScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 32)
    .map(([dir]) => dir);
}

function searchedDirsFromHits(hits: QueryHit[]): string[] {
  const dirs = [...new Set(hits.map((h) => parentDir(h.path)))];
  return dirs.sort((a, b) => a.localeCompare(b)).slice(0, 32);
}

function routeToPathFilters(route: ScopeRoute): { pathPrefix?: string; pathContains?: string } {
  if (route.kind === "prefix") return { pathPrefix: route.prefix };
  if (route.kind === "contains") return { pathContains: route.needle };
  return {};
}

function needsScopeExpand(hits: QueryHit[], limit: number, search: SearchConfig): boolean {
  const minHits = search.scope_expand_min_hits ?? 3;
  const maxScore = search.scope_expand_max_score ?? (search.fusion.fused_min ?? 0.05) * 4;
  if (hits.length < Math.min(limit, minHits)) return true;
  const top = hits[0]?.score ?? 0;
  return top < maxScore;
}

function withScopePlan(
  explain: QueryExplain | undefined,
  intent: QueryIntent,
  route: ScopeRoute,
  expand: "none" | "global",
): QueryExplain | undefined {
  if (!explain) return undefined;
  const rest = (explain.query_plan ?? []).filter(
    (s) => !s.startsWith("intent:") && !s.startsWith("scope:") && !s.startsWith("expand:"),
  );
  return {
    ...explain,
    query_plan: [`intent:${intent}`, `scope:${route.label}`, `expand:${expand}`, ...rest],
  };
}

async function runScopedHybrid(
  db: SqlClient,
  opts: HybridQueryOptions,
  q: string,
  intent: QueryIntent,
  search: SearchConfig,
  t0: number,
): Promise<HybridQueryResult> {
  const route = scopePrefixForIntent(intent);
  const base = { ...opts, scopePass: true, skipCache: true, omitQueryStat: true };
  if (route.kind === "off") {
    const inner = await hybridQueryDetailed(db, base);
    return finalizeHybridResult(opts, q, inner.hits, withScopePlan(inner.explain, intent, route, "none"), t0);
  }
  let expand = false;
  let narrowHits: QueryHit[] = [];
  let narrowExplain: QueryExplain | undefined;
  try {
    const narrow = await hybridQueryDetailed(db, { ...base, ...routeToPathFilters(route), explain: true });
    narrowHits = narrow.hits;
    narrowExplain = narrow.explain;
    expand = needsScopeExpand(narrowHits, opts.limit ?? 10, search);
  } catch {
    expand = true;
  }
  if (!expand) {
    return finalizeHybridResult(opts, q, narrowHits, withScopePlan(narrowExplain, intent, route, "none"), t0);
  }
  const global = await hybridQueryDetailed(db, {
    ...base,
    pathPrefix: undefined,
    pathContains: undefined,
    explain: opts.explain || Boolean(narrowExplain),
  });
  return finalizeHybridResult(opts, q, global.hits, withScopePlan(global.explain, intent, route, "global"), t0);
}

function buildQueryPlan(opts: {
  intent: QueryIntent;
  semanticAvailable: boolean;
  cosineStatus: "applied" | "skipped";
  directoryPrefilter: boolean;
  rerankStatus: RerankStatus;
}): string[] {
  const plan: string[] = [`intent:${opts.intent}`];
  if (opts.semanticAvailable) {
    plan.push("arms:bm25,semantic,graph");
  } else {
    plan.push("semantic:off");
  }
  plan.push("fusion:rrf_rescale", "floor", `cosine:${opts.cosineStatus}`, "signals", "hotness");
  plan.push(opts.directoryPrefilter ? "prefilter:dir" : "prefilter:off");
  plan.push(`rerank:${opts.rerankStatus}`);
  return plan;
}

type ScoreDetail = NonNullable<QueryExplain["score_details"]>[number];

function buildScoreDetails(
  finalHits: QueryHit[],
  fusedByPath: Map<string, FusedHit>,
  preHotnessScore: Map<string, number>,
  cosineByPath: Map<string, number>,
  hotnessByPath: Map<string, number>,
  cosineStatus: "applied" | "skipped",
): ScoreDetail[] {
  return finalHits.map((h) => {
    const f = fusedByPath.get(h.path);
    const detail: ScoreDetail = { path: h.path, final: h.score };
    if (f) {
      detail.kw = f.rrfBm25;
      detail.sem = f.rrfSemantic;
      detail.graph = f.rrfGraph;
      detail.title = f.titlePathBoost;
      detail.entity = f.entityBoost;
      detail.fused = preHotnessScore.get(h.path) ?? f.score;
    }
    if (cosineStatus === "applied") {
      const cos = cosineByPath.get(h.path);
      if (cos !== undefined) detail.cosine = cos;
    }
    const hb = hotnessByPath.get(h.path);
    if (hb !== undefined) detail.hotness = hb;
    return detail;
  });
}

async function finalizeHybridResult(
  opts: HybridQueryOptions,
  q: string,
  hits: QueryHit[],
  explain: QueryExplain | undefined,
  t0: number,
): Promise<HybridQueryResult> {
  const annotated = await withAnnotations(opts, hits);
  if (opts.repoRoot && !opts.omitQueryStat) {
    await bumpHitCounts(
      opts.repoRoot,
      annotated.map((h) => h.path),
    ).catch(() => {});
    const avgScore = annotated.length
      ? annotated.reduce((s, h) => s + h.score, 0) / annotated.length
      : 0;
    await recordQueryStat(opts.repoRoot, {
      query: q,
      hitCount: annotated.length,
      avgScore,
      latency_ms: Date.now() - t0,
      evidence: countEvidenceFromHits(annotated),
    }).catch(() => {});
  }
  return { hits: annotated, explain };
}

interface EntityBoostPack {
  boosts: Map<string, number>;
  details: Array<{ path: string; slug: string }>;
}

async function computeEntityBoosts(
  db: SqlClient,
  brainId: string,
  query: string,
): Promise<EntityBoostPack> {
  const boosts = new Map<string, number>();
  const details: Array<{ path: string; slug: string }> = [];
  const add = (path: string, slug: string, delta: number) => {
    const prev = boosts.get(path) ?? 0;
    boosts.set(path, Math.min(1, prev + delta));
    if (!details.some((d) => d.path === path && d.slug === slug)) {
      details.push({ path, slug });
    }
  };
  try {
    const q = query.trim().toLowerCase();
    if (!q) return { boosts, details };
    const ents = await db.query<{ slug: string; canonical_slug: string; title: string }>(
      `SELECT slug, canonical_slug, title FROM entity_registry
       WHERE brain_id = $2 AND status != 'merged'
         AND (position($1 in lower(slug)) > 0 OR position($1 in lower(title)) > 0
              OR position($1 in lower(aliases_json)) > 0)
       LIMIT 20`,
      [q, brainId],
    );
    if (ents.rows.length === 0) return { boosts, details };
    for (const e of ents.rows) {
      const slug = e.canonical_slug || e.slug;
      const links = await db.query<{ from_path: string }>(
        `SELECT DISTINCT from_path FROM links WHERE brain_id = $1 AND lower(to_ref) = $2`,
        [brainId, slug.toLowerCase()],
      );
      for (const row of links.rows) add(row.from_path, slug, 0.5);
      const entPath = `brains/${brainId}/entities/${slug}.md`;
      add(entPath, slug, 0.8);
      const needle = slug.toLowerCase();
      const titleNeedle = e.title.toLowerCase();
      const mentioned = await db.query<{ path: string }>(
        `SELECT path FROM pages WHERE brain_id = $1 AND status = 'active'
           AND (position($2 in lower(title)) > 0 OR position($2 in lower(body_text)) > 0
                OR position($3 in lower(title)) > 0 OR position($3 in lower(body_text)) > 0)
         LIMIT 50`,
        [brainId, needle, titleNeedle],
      );
      for (const row of mentioned.rows) add(row.path, slug, 0.45);
    }
  } catch {
    /* fail-open */
  }
  return { boosts, details };
}

async function resolveSearch(opts: HybridQueryOptions): Promise<SearchConfig> {
  if (opts.search) return opts.search;
  if (opts.repoRoot) {
    try {
      return (await loadRepoConfig(opts.repoRoot)).search;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_SEARCH_CONFIG;
}

export async function hybridQuery(db: SqlClient, opts: HybridQueryOptions): Promise<QueryHit[]> {
  const result = await hybridQueryDetailed(db, opts);
  return result.hits;
}

async function withAnnotations(opts: HybridQueryOptions, hits: QueryHit[]): Promise<QueryHit[]> {
  if (!opts.repoRoot) return hits;
  return annotateHits(opts.repoRoot, hits, { query: opts.query });
}

export async function hybridQueryDetailed(
  db: SqlClient,
  opts: HybridQueryOptions,
): Promise<HybridQueryResult> {
  const t0 = Date.now();
  const q = opts.query.trim();
  if (!q) {
    return finalizeHybridResult(opts, q, [], undefined, t0);
  }

  assertExclusiveSchemaFilters(opts);

  const limit = opts.limit ?? 10;
  const armLimit = limit * 3;
  const mode: SearchMode = opts.mode ?? "balanced";
  const intent = classifyIntent(q, opts.intentLexicon);
  const search = await resolveSearch(opts);
  const scopeFirst = opts.scopeFirst ?? search.scope_first === true;
  if (scopeFirst && !opts.scopePass) {
    return runScopedHybrid(db, opts, q, intent, search, t0);
  }

  const expandOn = mode === "tokenmax" && search.tokenmax.expand;
  const queries = expandOn ? heuristicExpand(q, search.tokenmax.expand_n) : [q];

  const embedder = opts.embedder ?? null;
  const semanticWanted = embedder != null && embedder.id !== "off" && mode !== "conservative";

  const bm25Groups: QueryHit[][] = [];
  for (const qi of queries) {
    bm25Groups.push(await bm25Query(db, { ...opts, query: qi, limit: armLimit }));
  }
  const bm25Hits = mergeBm25Groups(bm25Groups);
  const bm25Ranked: RankedHit[] = bm25Hits.map((h) => ({
    path: h.path,
    score: h.score,
    title: h.title,
    snippet: h.snippet,
    evidence: h.evidence,
  }));

  const titles = new Map<string, string>();
  const meta = new Map<string, { snippet?: string; title?: string; evidence?: string[] }>();
  const updatedAt = new Map<string, string>();
  for (const h of bm25Hits) {
    titles.set(h.path, h.title);
    meta.set(h.path, { snippet: h.snippet, title: h.title, evidence: h.evidence });
    if (h.updatedAt) updatedAt.set(h.path, h.updatedAt);
  }

  const aliasHits: string[] = [];
  if (search.alias_hop) {
    for (const h of bm25Hits) {
      if (h.evidence.includes("alias")) aliasHits.push(h.title || h.path);
    }
  }

  let semanticHits: RankedHit[] = [];
  let semanticAvailable = false;
  let queryVec: number[] | undefined;

  if (semanticWanted && embedder) {
    const stale =
      opts.repoRoot != null &&
      embeddingMetaMismatch(await readEmbeddingMeta(opts.repoRoot), embedder);
    if (!stale) {
      try {
        const [qv] = await embedder.embed([q]);
        queryVec = qv;
        if (queryVec && queryVec.length > 0) {
          semanticHits = await semanticArm(db, {
            brainId: opts.brainId,
            queryVec,
            limit: armLimit,
            sourceId: opts.sourceId,
            query: q,
            schemaType: opts.schemaType,
            excludeSchemaTypes: opts.excludeSchemaTypes,
            excludeSidecars: opts.excludeSidecars,
            pathPrefix: opts.pathPrefix,
            pathContains: opts.pathContains,
          });
          semanticAvailable = true;
          for (const h of semanticHits) {
            if (h.title) titles.set(h.path, h.title);
            if (!meta.has(h.path)) {
              meta.set(h.path, { snippet: h.snippet, title: h.title, evidence: h.evidence });
            }
          }
        }
      } catch {
        semanticHits = [];
        semanticAvailable = false;
        queryVec = undefined;
      }
    }
  }

  let graphHits: RankedHit[] = [];
  let graphMode: GraphMode = "empty";
  try {
    const graph = await graphArmDetailed(db, {
      brainId: opts.brainId,
      query: q,
      limit: armLimit,
      sourceId: opts.sourceId,
      schemaType: opts.schemaType,
      excludeSchemaTypes: opts.excludeSchemaTypes,
      excludeSidecars: opts.excludeSidecars,
      pathPrefix: opts.pathPrefix,
      pathContains: opts.pathContains,
    });
    graphHits = graph.hits;
    graphMode = graph.mode;
    for (const h of graphHits) {
      if (h.title) titles.set(h.path, h.title);
      if (!meta.has(h.path)) {
        meta.set(h.path, { snippet: h.snippet, title: h.title, evidence: h.evidence });
      }
    }
  } catch {
    graphHits = [];
    graphMode = "empty";
  }

  const knobs = buildKnobs(opts, intent, mode, limit, semanticAvailable, search);
  const useCache = !opts.skipCache && !opts.explain;

  if (useCache) {
    const cached = await getSearchCache(db, q, knobs);
    if (cached) {
      const cachedHits = cached.hits;
      const cacheRerank: RerankStatus = search.tokenmax.rerank;
      const cacheExplain: QueryExplain | undefined = opts.explain
        ? {
            intent,
            mode,
            cacheHit: true,
            knobsHash: cached.knobsHash,
            arms: {
              bm25: armRanks(bm25Ranked),
              semantic: armRanks(semanticHits),
              graph: armRanks(graphHits),
            },
            signals: { hub: [], crossSource: [], diversified: [] },
            weightsKey: knobs.weightsKey,
            queries,
            rerank: cacheRerank,
            hotness: search.hotness.enabled,
            directory_prefilter: search.directory_prefilter ? null : null,
            graph_mode: graphMode,
            ...(embedder?.fallbackFrom ? { embedding_fallback: "local" as const } : {}),
            query_plan: buildQueryPlan({
              intent,
              semanticAvailable,
              cosineStatus: "skipped",
              directoryPrefilter: search.directory_prefilter,
              rerankStatus: cacheRerank,
            }),
            searched_directories: searchedDirsFromHits(cachedHits),
            score_details: cachedHits.map((h) => ({ path: h.path, final: h.score })),
          }
        : undefined;
      return finalizeHybridResult(opts, q, cachedHits, cacheExplain, t0);
    }
  }

  const entityPack = search.entity_boost
    ? await computeEntityBoosts(db, opts.brainId, q)
    : { boosts: new Map<string, number>(), details: [] as Array<{ path: string; slug: string }> };

  let fused: FusedHit[] = fuseHybridArms(bm25Ranked, semanticHits, {
    mode,
    query: q,
    titles,
    meta,
    limit: armLimit,
    semanticAvailable,
    graphHits,
    entityBoosts: entityPack.boosts,
    intent,
    fusion: search.fusion ?? DEFAULT_FUSION_CONFIG,
  });

  const fusedByPath = new Map<string, FusedHit>();
  if (opts.explain) {
    for (const f of fused) fusedByPath.set(f.path, { ...f });
  }

  const fusionCfg = search.fusion ?? DEFAULT_FUSION_CONFIG;
  const cosineLambda = fusionCfg.cosine_lambda;
  let cosineStatus: "applied" | "skipped" = "skipped";
  const cosineByPath = new Map<string, number>();
  if (embedder && embedder.id !== "off" && queryVec && queryVec.length > 0 && cosineLambda > 0) {
    for (const h of semanticHits) {
      if (typeof h.score === "number") cosineByPath.set(h.path, Math.max(0, h.score));
    }
    fused = fused.map((h) => {
      const cos = Math.max(0, cosineByPath.get(h.path) ?? 0);
      return { ...h, score: (1 - cosineLambda) * h.score + cosineLambda * cos };
    });
    cosineStatus = "applied";
  }

  let signalExplain: SignalExplain = { hub: [], crossSource: [], diversified: [] };
  try {
    const applied = await applyGraphSignals(db, fused, { brainId: opts.brainId, topK: Math.min(20, fused.length) });
    fused = applied.hits;
    signalExplain = applied.signals;
  } catch {
    /* fail-open */
  }

  const preHotnessScore = new Map<string, number>();
  if (opts.explain) {
    for (const f of fused) preHotnessScore.set(f.path, f.score);
  }

  const hotnessByPath = new Map<string, number>();
  let hitCounts: Record<string, number> = {};
  const freqOn = search.hotness.freq !== false;
  if (search.hotness.enabled && freqOn && opts.repoRoot) {
    try {
      hitCounts = (await readHitCounts(opts.repoRoot)).counts;
    } catch {
      hitCounts = {};
    }
  }
  if (search.hotness.enabled) {
    if (opts.explain) {
      for (const f of fused) {
        const recency = hotnessBoost(updatedAt.get(f.path), search.hotness.half_life_days);
        const n = freqOn ? (hitCounts[f.path.replace(/\\/g, "/")] ?? 0) : 0;
        hotnessByPath.set(f.path, recency * freqFromHitCount(n));
      }
    }
    fused = applyHotness(fused, updatedAt, search.hotness.half_life_days, search.hotness.alpha ?? 0.15, {
      counts: hitCounts,
      freq: freqOn,
    });
  }

  let staleExplain: StaleDemoteExplain[] = [];
  if (search.stale_demote === true && opts.repoRoot) {
    try {
      const pairs = await loadCrossFilePairs(opts.repoRoot, opts.brainId);
      if (pairs.length) {
        const applied = applyStaleDemote(fused, pairs, updatedAt, search.stale_demote_factor ?? 0.85);
        fused = applied.hits;
        staleExplain = applied.explain;
      }
    } catch {
      staleExplain = [];
    }
  }
  fused = sortWithTieBreak(fused);

  let dirExplain: DirectoryPrefilterExplain | null = null;
  let prefilterFused: FusedHit[] | null = null;
  if (search.directory_prefilter) {
    if (opts.explain) prefilterFused = [...fused];
    const pf = applyDirectoryPrefilter(fused);
    fused = pf.hits;
    dirExplain = pf.explain;
  }

  const titlePhrase = fused.some((f) => titlePhraseHit(q, f.title ?? titles.get(f.path) ?? ""));

  let hits: QueryHit[] = fused.slice(0, Math.max(limit, search.tokenmax.rerank_top_n)).map((f) => {
    const bm = bm25Hits.find((h) => h.path === f.path);
    const abstract = bm?.abstract;
    return {
      path: f.path,
      title: f.title ?? titles.get(f.path) ?? f.path,
      score: f.score,
      snippet: f.snippet ?? meta.get(f.path)?.snippet ?? "",
      evidence: f.evidence,
      ...(abstract ? { abstract } : {}),
      updatedAt: bm?.updatedAt ?? updatedAt.get(f.path),
    };
  });

  let rerankStatus: RerankStatus = search.tokenmax.rerank;
  let rerankScores: Array<{ path: string; score: number }> | undefined;
  const wantModel = search.tokenmax.rerank === "model" && mode === "tokenmax";
  const wantLocal = search.tokenmax.rerank === "local" || wantModel;
  if (wantLocal || opts.rerankFn) {
    try {
      if (wantModel && opts.rerankFn) {
        hits = await opts.rerankFn(q, hits);
        rerankStatus = "model";
      } else if (opts.rerankFn && search.tokenmax.rerank !== "off") {
        hits = await opts.rerankFn(q, hits);
        rerankStatus = "local";
      } else if (wantLocal) {
        rerankScores = hits.slice(0, search.tokenmax.rerank_top_n).map((h) => ({
          path: h.path,
          score: localRerankScore(q, h.title, h.snippet),
        }));
        hits = localRerank(q, hits, search.tokenmax.rerank_top_n);
        rerankStatus = "local";
      }
    } catch {
      if (wantModel) {
        try {
          hits = localRerank(q, hits, search.tokenmax.rerank_top_n);
          rerankStatus = "local";
        } catch {
          rerankStatus = "skipped";
        }
      } else {
        rerankStatus = "skipped";
      }
    }
  }

  hits = hits.slice(0, limit);

  if (useCache) {
    await setSearchCache(db, q, knobs, hits);
  }

  const searched_directories = dirExplain
    ? searchedDirsFromPrefilter(prefilterFused ?? fused)
    : searchedDirsFromHits(hits);

  const explain: QueryExplain | undefined = opts.explain
    ? {
        intent,
        mode,
        cacheHit: false,
        knobsHash: knobsHash(knobs),
        arms: {
          bm25: armRanks(bm25Ranked),
          semantic: armRanks(semanticHits),
          graph: armRanks(graphHits),
        },
        signals: signalExplain,
        weightsKey: knobs.weightsKey,
        queries,
        rerank: rerankStatus,
        entity_boosts: entityPack.details,
        alias_hits: aliasHits,
        title_phrase: titlePhrase,
        hotness: search.hotness.enabled,
        directory_prefilter: dirExplain,
        graph_mode: graphMode,
        ...(embedder?.fallbackFrom ? { embedding_fallback: "local" as const } : {}),
        fusion: {
          rescale: fusionCfg.rescale,
          per_arm_min: fusionCfg.per_arm_min,
          fused_min: fusionCfg.fused_min,
          cosine: cosineStatus,
        },
        hotness_detail: {
          alpha: search.hotness.alpha ?? 0.15,
          mode: "multiply",
          freq:
            !freqOn || !fused.some((h) => (hitCounts[h.path.replace(/\\/g, "/")] ?? 0) > 0)
              ? "identity"
              : "applied",
        },
        ...(rerankScores ? { rerank_scores: rerankScores } : {}),
        query_plan: buildQueryPlan({
          intent,
          semanticAvailable,
          cosineStatus,
          directoryPrefilter: search.directory_prefilter,
          rerankStatus,
        }),
        searched_directories,
        stale_demote: staleExplain,
        score_details: buildScoreDetails(
          hits,
          fusedByPath,
          preHotnessScore,
          cosineByPath,
          hotnessByPath,
          cosineStatus,
        ),
      }
    : undefined;

  return finalizeHybridResult(opts, q, hits, explain, t0);
}
