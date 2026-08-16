import type { SqlClient } from "../index/sql.ts";
import type { EmbeddingProvider, SearchConfig } from "../embed/types.ts";
import { DEFAULT_SEARCH_CONFIG } from "../embed/types.ts";
import { readEmbeddingMeta } from "../index/meta.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { bm25Query, type QueryHit, type QueryOptions, assertExclusiveSchemaFilters } from "./query.ts";
import {
  fuseHybridArms,
  resolveFusionWeights,
  weightsKey,
  type RankedHit,
  type SearchMode,
  type FusedHit,
} from "./rrf.ts";
import { semanticArm } from "./semantic.ts";
import { classifyIntent, type QueryIntent } from "./intent.ts";
import { graphArmDetailed, type GraphMode } from "./graph.ts";
import { applyGraphSignals, type SignalExplain } from "./signals.ts";
import { getSearchCache, setSearchCache, knobsHash, type SearchKnobs } from "./cache.ts";
import { heuristicExpand } from "./expand.ts";
import { localRerank, localRerankScore, type RerankStatus } from "./rerank.ts";
import { applyHotness } from "./hotness.ts";
import { applyDirectoryPrefilter, type DirectoryPrefilterExplain } from "./prefilter.ts";
import { annotateHits } from "./annotate.ts";

export interface HybridQueryOptions extends QueryOptions {
  mode?: SearchMode;
  embedder?: EmbeddingProvider | null;
  schemaType?: string;
  repoRoot?: string;
  intentLexicon?: Record<string, string[]> | null;
  skipCache?: boolean;
  explain?: boolean;
  search?: SearchConfig;
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
  const q = opts.query.trim();
  if (!q) return { hits: [] };

  assertExclusiveSchemaFilters(opts);

  const limit = opts.limit ?? 10;
  const armLimit = limit * 3;
  const mode: SearchMode = opts.mode ?? "balanced";
  const intent = classifyIntent(q, opts.intentLexicon);
  const search = await resolveSearch(opts);

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

  if (semanticWanted && embedder) {
    const stale =
      opts.repoRoot != null &&
      embeddingMetaMismatch(await readEmbeddingMeta(opts.repoRoot), embedder);
    if (!stale) {
      try {
        const [queryVec] = await embedder.embed([q]);
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
      const explain: QueryExplain | undefined = opts.explain
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
            rerank: search.tokenmax.rerank,
            hotness: search.hotness.enabled,
            directory_prefilter: search.directory_prefilter ? null : null,
            graph_mode: graphMode,
          }
        : undefined;
      return { hits: await withAnnotations(opts, cached.hits), explain };
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
  });

  let signalExplain: SignalExplain = { hub: [], crossSource: [], diversified: [] };
  try {
    const applied = await applyGraphSignals(db, fused, { brainId: opts.brainId, topK: Math.min(20, fused.length) });
    fused = applied.hits;
    signalExplain = applied.signals;
  } catch {
    /* fail-open */
  }

  if (search.hotness.enabled) {
    fused = applyHotness(fused, updatedAt, search.hotness.half_life_days);
  }

  let dirExplain: DirectoryPrefilterExplain | null = null;
  if (search.directory_prefilter) {
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
  if (search.tokenmax.rerank === "local" || opts.rerankFn) {
    try {
      if (opts.rerankFn) {
        hits = await opts.rerankFn(q, hits);
        rerankStatus = "local";
      } else {
        rerankScores = hits.slice(0, search.tokenmax.rerank_top_n).map((h) => ({
          path: h.path,
          score: localRerankScore(q, h.title, h.snippet),
        }));
        hits = localRerank(q, hits, search.tokenmax.rerank_top_n);
        rerankStatus = "local";
      }
    } catch {
      rerankStatus = "skipped";
    }
  }

  hits = hits.slice(0, limit);

  if (useCache) {
    await setSearchCache(db, q, knobs, hits);
  }

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
        ...(rerankScores ? { rerank_scores: rerankScores } : {}),
      }
    : undefined;

  return { hits: await withAnnotations(opts, hits), explain };
}
