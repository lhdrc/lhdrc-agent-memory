import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingProvider } from "../embed/types.ts";
import { readEmbeddingMeta } from "../index/meta.ts";
import { bm25Query, type QueryHit, type QueryOptions } from "./query.ts";
import { fuseHybridArms, type RankedHit, type SearchMode } from "./rrf.ts";
import { semanticArm } from "./semantic.ts";

export interface HybridQueryOptions extends QueryOptions {
  mode?: SearchMode;
  embedder?: EmbeddingProvider | null;
  /** P2.2 预留 */
  schemaType?: string;
  repoRoot?: string;
}

function embeddingMetaMismatch(
  stored: { provider: string; dims: number } | null,
  embedder: EmbeddingProvider,
): boolean {
  if (!stored) return false;
  return stored.provider !== embedder.id || stored.dims !== embedder.dims;
}

/**
 * P2.1a 混合检索：BM25 + 语义臂 → RRF 融合。
 * provider=off 或 mode=conservative 时语义臂为空，fail-open。
 */
export async function hybridQuery(db: PGlite, opts: HybridQueryOptions): Promise<QueryHit[]> {
  const q = opts.query.trim();
  if (!q) return [];

  const limit = opts.limit ?? 10;
  const armLimit = limit * 3;
  const mode: SearchMode = opts.mode ?? "balanced";

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

  const embedder = opts.embedder ?? null;
  const semanticOn = embedder != null && embedder.id !== "off" && mode !== "conservative";

  if (semanticOn) {
    const stale =
      opts.repoRoot != null &&
      embeddingMetaMismatch(await readEmbeddingMeta(opts.repoRoot), embedder);
    // provider/dims 变更后未 rebuild：跳过语义臂（fail-open），避免错维向量污染排序
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

  const fused = fuseHybridArms(bm25Ranked, semanticHits, {
    mode,
    query: q,
    titles,
    meta,
    limit,
    semanticAvailable,
  });

  return fused.map((f) => ({
    path: f.path,
    title: f.title ?? titles.get(f.path) ?? f.path,
    score: f.score,
    snippet: f.snippet ?? meta.get(f.path)?.snippet ?? "",
    evidence: f.evidence,
  }));
}
