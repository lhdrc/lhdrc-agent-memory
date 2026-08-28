import type { SqlClient } from "../index/sql.ts";
import { bytesToFloat32View, cosineSimilarity, toFloat32 } from "../embed/cosine.ts";
import { makeSnippet } from "./query.ts";
import { appendPageFilters } from "./filters.ts";
import type { RankedHit } from "./rrf.ts";
import { PGVECTOR_WARN } from "../index/postgres.ts";
import {
  embedCacheStoreKey,
  getEmbeddingCache,
  semanticFilterKey,
  setEmbeddingCache,
  type CachedEmbedChunk,
} from "./embed-cache.ts";

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

  const params: unknown[] = [opts.brainId];
  const pageFilters = appendPageFilters(opts, 2, "p.");
  const extraWhere = pageFilters.clauses.length ? ` AND ${pageFilters.clauses.join(" AND ")}` : "";
  params.push(...pageFilters.params);

  const filterKey = semanticFilterKey(opts);
  const cacheKey = opts.repoRoot
    ? embedCacheStoreKey(opts.repoRoot, opts.brainId, filterKey)
    : null;

  let chunks: CachedEmbedChunk[] | null = null;
  if (cacheKey) {
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
    const fingerprint = `${fpRes.rows[0]?.n ?? 0}:${fpRes.rows[0]?.nbytes ?? 0}`;
    chunks = getEmbeddingCache(cacheKey, fingerprint);
    if (!chunks) {
      chunks = await loadScoreRows(db, extraWhere, params);
      setEmbeddingCache(cacheKey, fingerprint, chunks);
    }
  } else {
    chunks = await loadScoreRows(db, extraWhere, params);
  }

  const queryVec = toFloat32(opts.queryVec);
  const pathBest = new Map<string, { score: number; id: string }>();

  for (const row of chunks) {
    const score = cosineSimilarity(queryVec, row.vec);
    const prev = pathBest.get(row.path);
    if (!prev || score > prev.score) {
      pathBest.set(row.path, { score, id: row.id });
    }
  }

  const rankedIds: Array<{ path: string; score: number; id: string }> = [];
  for (const [path, { score, id }] of pathBest) {
    rankedIds.push({ path, score, id });
  }
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
