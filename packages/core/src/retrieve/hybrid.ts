import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingProvider } from "../embed/types.ts";
import { readEmbeddingMeta } from "../index/meta.ts";
import { bm25Query, type QueryHit, type QueryOptions } from "./query.ts";
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
import { graphArm } from "./graph.ts";
import { applyGraphSignals, type SignalExplain } from "./signals.ts";
import { getSearchCache, setSearchCache, knobsHash, type SearchKnobs } from "./cache.ts";

export interface HybridQueryOptions extends QueryOptions {
  mode?: SearchMode;
  embedder?: EmbeddingProvider | null;
  /** P2.2 / P3.1 */
  schemaType?: string;
  repoRoot?: string;
  /** schema pack intent_lexicon */
  intentLexicon?: Record<string, string[]> | null;
  /** 跳过 search_cache */
  skipCache?: boolean;
  /** 返回 explain 细节 */
  explain?: boolean;
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

function buildKnobs(
  opts: HybridQueryOptions,
  intent: QueryIntent,
  mode: SearchMode,
  limit: number,
  semanticAvailable: boolean,
): SearchKnobs {
  const semOn = semanticAvailable && mode !== "conservative";
  return {
    mode,
    brainId: opts.brainId,
    intent,
    sourceId: opts.sourceId,
    schemaType: opts.schemaType,
    weightsKey: weightsKey(resolveFusionWeights(intent, semOn)),
    limit,
    semanticAvailable: semOn,
  };
}

/** 实体 boost：query 命中 entity slug/title → 抬升链入该实体的 pages（按 brain 隔离） */
async function computeEntityBoosts(
  db: PGlite,
  brainId: string,
  query: string,
): Promise<Map<string, number>> {
  const boosts = new Map<string, number>();
  try {
    const q = query.trim().toLowerCase();
    if (!q) return boosts;
    const ents = await db.query<{ slug: string; canonical_slug: string; title: string }>(
      `SELECT slug, canonical_slug, title FROM entity_registry
       WHERE brain_id = $2 AND status != 'merged'
         AND (position($1 in lower(slug)) > 0 OR position($1 in lower(title)) > 0
              OR position($1 in lower(aliases_json)) > 0)
       LIMIT 20`,
      [q, brainId],
    );
    if (ents.rows.length === 0) return boosts;
    for (const e of ents.rows) {
      const slug = e.canonical_slug || e.slug;
      const links = await db.query<{ from_path: string }>(
        `SELECT DISTINCT from_path FROM links WHERE brain_id = $1 AND lower(to_ref) = $2`,
        [brainId, slug.toLowerCase()],
      );
      for (const row of links.rows) {
        const prev = boosts.get(row.from_path) ?? 0;
        boosts.set(row.from_path, Math.min(1, prev + 0.5));
      }
      const entPath = `brains/${brainId}/entities/${slug}.md`;
      boosts.set(entPath, Math.min(1, (boosts.get(entPath) ?? 0) + 0.8));
    }
  } catch {
    /* fail-open */
  }
  return boosts;
}

/**
 * P2.1a + P3.1 混合检索：BM25 + 语义 + graph → RRF → signals。
 * provider=off 或 mode=conservative 时语义臂为空；graph 解析失败 fail-open。
 * search_cache knobs 使用实际 semanticAvailable（非仅 semanticWanted）。
 */
export async function hybridQuery(db: PGlite, opts: HybridQueryOptions): Promise<QueryHit[]> {
  const result = await hybridQueryDetailed(db, opts);
  return result.hits;
}

export async function hybridQueryDetailed(
  db: PGlite,
  opts: HybridQueryOptions,
): Promise<HybridQueryResult> {
  const q = opts.query.trim();
  if (!q) return { hits: [] };

  const limit = opts.limit ?? 10;
  const armLimit = limit * 3;
  const mode: SearchMode = opts.mode ?? "balanced";
  const intent = classifyIntent(q, opts.intentLexicon);

  const embedder = opts.embedder ?? null;
  const semanticWanted = embedder != null && embedder.id !== "off" && mode !== "conservative";

  const bm25Hits = await bm25Query(db, { ...opts, limit: armLimit, schemaType: opts.schemaType });
  const bm25Ranked: RankedHit[] = bm25Hits.map((h) => ({
    path: h.path,
    score: h.score,
    title: h.title,
    snippet: h.snippet,
    evidence: h.evidence,
  }));

  const titles = new Map<string, string>();
  const meta = new Map<string, { snippet?: string; title?: string; evidence?: string[] }>();
  for (const h of bm25Hits) {
    titles.set(h.path, h.title);
    meta.set(h.path, { snippet: h.snippet, title: h.title, evidence: h.evidence });
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
  try {
    graphHits = await graphArm(db, {
      brainId: opts.brainId,
      query: q,
      limit: armLimit,
      sourceId: opts.sourceId,
    });
    for (const h of graphHits) {
      if (h.title) titles.set(h.path, h.title);
      if (!meta.has(h.path)) {
        meta.set(h.path, { snippet: h.snippet, title: h.title, evidence: h.evidence });
      }
    }
  } catch {
    graphHits = [];
  }

  // knobs 在得知实际 semanticAvailable 之后再算，保证 cache 与融合权重一致
  const knobs = buildKnobs(opts, intent, mode, limit, semanticAvailable);

  if (!opts.skipCache) {
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
          }
        : undefined;
      return { hits: cached.hits, explain };
    }
  }

  const entityBoosts = await computeEntityBoosts(db, opts.brainId, q);

  const fused: FusedHit[] = fuseHybridArms(bm25Ranked, semanticHits, {
    mode,
    query: q,
    titles,
    meta,
    limit: armLimit,
    semanticAvailable,
    graphHits,
    entityBoosts,
    intent,
  });

  let signalExplain: SignalExplain = { hub: [], crossSource: [], diversified: [] };
  let afterSignals = fused;
  try {
    const applied = await applyGraphSignals(db, fused, { brainId: opts.brainId, topK: Math.min(20, fused.length) });
    afterSignals = applied.hits;
    signalExplain = applied.signals;
  } catch {
    /* fail-open */
  }

  const top = afterSignals.slice(0, limit);
  const hits: QueryHit[] = top.map((f) => ({
    path: f.path,
    title: f.title ?? titles.get(f.path) ?? f.path,
    score: f.score,
    snippet: f.snippet ?? meta.get(f.path)?.snippet ?? "",
    evidence: f.evidence,
  }));

  if (!opts.skipCache) {
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
      }
    : undefined;

  return { hits, explain };
}
