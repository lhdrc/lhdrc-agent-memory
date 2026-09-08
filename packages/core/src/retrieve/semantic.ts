import type { SqlClient } from "../index/sql.ts";
import { bytesToFloat32View, cosineSimilarity, toFloat32 } from "../embed/cosine.ts";
import { makeSnippet } from "./query.ts";
import { appendPageFilters } from "./filters.ts";
import type { RankedHit } from "./rrf.ts";
import { PGVECTOR_WARN } from "../index/postgres.ts";
import {
  embedCacheStoreKey,
  getEmbeddingCache,
  getHnswResultCache,
  hnswResultKey,
  queryVecFingerprint,
  semanticFilterKey,
  setEmbeddingCache,
  setHnswResultCache,
  type CachedEmbedChunk,
} from "./embed-cache.ts";

/** 行数:字节数指纹（只含 length() 聚合，不计打分 SELECT）。 */
async function semanticFingerprint(
  db: SqlClient,
  params: unknown[],
  extraWhere: string,
): Promise<string | null> {
  try {
    const fpRes = await db.query<{ n: string | number; nbytes: string | number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(length(c.embedding)), 0) AS nbytes
       FROM chunks c
       INNER JOIN pages p ON p.path = c.path
       WHERE p.status = 'active'
         AND p.brain_id = $1
         AND c.embedding IS NOT NULL
         ${extraWhere}`,
      params,
    );
    return `${fpRes.rows[0]?.n ?? 0}:${fpRes.rows[0]?.nbytes ?? 0}`;
  } catch {
    return null;
  }
}

let warnedSkipSemantic = false;

export interface SemanticArmOptions {
  brainId: string;
  queryVec: number[] | Float32Array;
  limit: number;
  sourceId?: string;
  /** 用于 snippet 高亮 */
  query?: string;
  /** P2.2 预留：按 schema_type 过滤 */
  schemaType?: string;
  /** P8.2 */
  excludeSchemaTypes?: string[];
  excludeSidecars?: boolean;
  pathPrefix?: string;
  pathContains?: string;
  /** P12.1：进程内缓存 key；缺省不缓存 */
  repoRoot?: string;
}

function isScoreEmbeddingSql(sql: string): boolean {
  return /c\.embedding/i.test(sql) && !/length\s*\(\s*c\.embedding/i.test(sql);
}

export function isSemanticScoreSql(sql: string): boolean {
  return isScoreEmbeddingSql(sql);
}

/**
 * 语义臂：brute-force cosine vs chunks.embedding（非 null）→ 同 path max-pool → top limit。
 * P12.1：打分不拉 text；winner 再取 snippet。
 */
export async function semanticArm(db: SqlClient, opts: SemanticArmOptions): Promise<RankedHit[]> {
  if (db.engine === "postgres" && !db.pgvector) {
    if (!warnedSkipSemantic) {
      warnedSkipSemantic = true;
      console.warn(PGVECTOR_WARN);
    }
    return [];
  }
  const { ensureSchema } = await import("../index/engine.ts");
  await ensureSchema(db);

  const queryVec = toFloat32(opts.queryVec);
  const params: unknown[] = [opts.brainId];
  const pageFilters = appendPageFilters(opts, 2, "p.");
  const extraWhere = pageFilters.clauses.length ? ` AND ${pageFilters.clauses.join(" AND ")}` : "";
  params.push(...pageFilters.params);

  const filterKey = semanticFilterKey(opts);
  const cacheKey = opts.repoRoot
    ? embedCacheStoreKey(opts.repoRoot, opts.brainId, filterKey)
    : null;

  // P14.4：HNSW 结果缓存（命中则零打分 SELECT；键含全向量指纹，防串味）
  let fingerprint: string | null = null;
  let hnswKey: string | null = null;
  if (cacheKey) {
    fingerprint = await semanticFingerprint(db, params, extraWhere);
    if (fingerprint) {
      hnswKey = hnswResultKey(
        opts.repoRoot!,
        opts.brainId,
        filterKey,
        Math.max(1, Math.floor(opts.limit)),
        queryVecFingerprint(queryVec),
      );
      const hit = getHnswResultCache<RankedHit>(hnswKey, fingerprint);
      if (hit) return hit;
    }
  }

  // P14.4：HNSW 优先命中直接返回；失败/无候选回退暴力（fail-open）
  try {
    const hnsw = await hnswCandidates(db, opts, queryVec);
    if (hnsw && hnsw.length > 0) {
      const ranked = await poolAndFetch(db, hnsw, opts);
      if (hnswKey && fingerprint) setHnswResultCache(hnswKey, fingerprint, ranked);
      return ranked;
    }
  } catch {
    /* fall through to brute force */
  }

  let chunks: CachedEmbedChunk[] | null = null;
  if (cacheKey && fingerprint) {
    chunks = getEmbeddingCache(cacheKey, fingerprint);
    if (!chunks) {
      chunks = await loadScoreRows(db, extraWhere, params);
      setEmbeddingCache(cacheKey, fingerprint, chunks);
    }
  } else {
    chunks = await loadScoreRows(db, extraWhere, params);
  }

  const pathBest = new Map<string, { score: number; id: string }>();

  for (const row of chunks) {
    const score = cosineSimilarity(queryVec, row.vec);
    const prev = pathBest.get(row.path);
    if (!prev || score > prev.score) {
      pathBest.set(row.path, { score, id: row.id });
    }
  }

  return poolAndFetch(
    db,
    [...pathBest].map(([path, v]) => ({ path, ...v })),
    opts,
  );
}

/** P14.4：HNSW 候选（score = 1 - cosine 距离）→ 与暴力同口径 max-pool。 */
async function hnswCandidates(
  db: SqlClient,
  opts: SemanticArmOptions,
  queryVec: Float32Array,
): Promise<Array<{ path: string; id: string; score: number }> | null> {
  try {
    const { ensureVectorIndex, vectorText, HNSW_CANDIDATE_MULT, HNSW_CANDIDATE_MIN } =
      await import("../index/vector-index.ts");
    if (!(await ensureVectorIndex(db, queryVec.length))) return null;
    const pageFilters = appendPageFilters(opts, 3, "p.");
    const extraWhere = pageFilters.clauses.length ? ` AND ${pageFilters.clauses.join(" AND ")}` : "";
    const k = Math.max(Math.floor(opts.limit) * HNSW_CANDIDATE_MULT, HNSW_CANDIDATE_MIN);
    const qvt = vectorText(queryVec);
    const result = await db.query<{ id: string; path: string; d: number | string }>(
      `SELECT c.id, c.path, c.embedding_vec <=> $2::vector AS d
       FROM chunks c
       INNER JOIN pages p ON p.path = c.path
       WHERE p.status = 'active'
         AND p.brain_id = $1
         AND c.embedding_vec IS NOT NULL
         ${extraWhere}
       ORDER BY c.embedding_vec <=> $2::vector
       LIMIT ${k}`,
      [opts.brainId, qvt, ...pageFilters.params],
    );
    if (result.rows.length === 0) return null;
    const best = new Map<string, { score: number; id: string }>();
    for (const row of result.rows) {
      const score = 1 - Number(row.d);
      const prev = best.get(row.path);
      if (!prev || score > prev.score) {
        best.set(row.path, { score, id: String(row.id) });
      }
    }
    return [...best].map(([path, v]) => ({ path, ...v }));
  } catch {
    return null;
  }
}

/** 按篇 max-pool 已在上游完成；此处排序 → 截断 → 取 winner 正文。 */
async function poolAndFetch(
  db: SqlClient,
  cands: Array<{ path: string; id: string; score: number }>,
  opts: SemanticArmOptions,
): Promise<RankedHit[]> {
  const rankedIds = [...cands];
  rankedIds.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const top = rankedIds.slice(0, Math.max(1, Math.floor(opts.limit)));
  if (top.length === 0) return [];

  const meta = await fetchWinnerMeta(db, top.map((t) => t.id));
  const ranked: RankedHit[] = [];
  for (const t of top) {
    const m = meta.get(t.id);
    const text = m?.text ?? "";
    const title = m?.title ?? t.path.split("/").pop() ?? t.path;
    ranked.push({
      path: t.path,
      score: t.score,
      title,
      snippet: opts.query ? makeSnippet(text, opts.query) : text.slice(0, 160),
      evidence: ["semantic"],
    });
  }
  return ranked;
}

async function loadScoreRows(
  db: SqlClient,
  extraWhere: string,
  params: unknown[],
): Promise<CachedEmbedChunk[]> {
  const sql = `
    SELECT c.id, c.path, c.embedding
    FROM chunks c
    INNER JOIN pages p ON p.path = c.path
    WHERE p.status = 'active'
      AND p.brain_id = $1
      AND c.embedding IS NOT NULL
      ${extraWhere}`;

  const result = await db.query<{
    id: string;
    path: string;
    embedding: Uint8Array | Buffer;
  }>(sql, params);

  return result.rows.map((row) => ({
    id: String(row.id),
    path: String(row.path),
    vec: bytesToFloat32View(row.embedding),
  }));
}

async function fetchWinnerMeta(
  db: SqlClient,
  ids: string[],
): Promise<Map<string, { text: string; title: string }>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `
    SELECT c.id, c.text, p.title
    FROM chunks c
    INNER JOIN pages p ON p.path = c.path
    WHERE c.id IN (${placeholders})`;
  const result = await db.query<{ id: string; text: string; title: string }>(sql, ids);
  const out = new Map<string, { text: string; title: string }>();
  for (const row of result.rows) {
    out.set(String(row.id), { text: String(row.text), title: String(row.title) });
  }
  return out;
}
