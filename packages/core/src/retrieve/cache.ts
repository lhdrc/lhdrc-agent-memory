/**
 * P3.1 search_cache：cache_key = hash(query + knobs_hash)。
 */
import type { SqlClient } from "../index/sql.ts";
import { sha256Hex } from "../util/hash.ts";
import type { SearchMode } from "./rrf.ts";
import type { QueryIntent } from "./intent.ts";
import type { QueryHit } from "./query.ts";

export interface SearchKnobs {
  mode: SearchMode;
  brainId: string;
  intent: QueryIntent;
  sourceId?: string;
  schemaType?: string;
  /** P8.2 */
  excludeSchemaTypes?: string[];
  excludeSidecars?: boolean;
  /** P5.3 检索增强开关指纹 */
  advKey?: string;
  /** P11.1 */
  pathPrefix?: string;
  pathContains?: string;
}

export function knobsHash(knobs: SearchKnobs): string {
  return sha256Hex(
    JSON.stringify({
      mode: knobs.mode,
      brainId: knobs.brainId,
      intent: knobs.intent,
      sourceId: knobs.sourceId ?? "",
      schemaType: knobs.schemaType ?? "",
      excludeSchemaTypes: knobs.excludeSchemaTypes?.slice().sort().join(",") ?? "",
      excludeSidecars: knobs.excludeSidecars ?? false,
      weightsKey: knobs.weightsKey,
      limit: knobs.limit,
      semanticAvailable: knobs.semanticAvailable,
      advKey: knobs.advKey ?? "",
      pathPrefix: knobs.pathPrefix ?? "",
      pathContains: knobs.pathContains ?? "",
    }),
  );
}

export function cacheKey(query: string, knobs: SearchKnobs): string {
  return sha256Hex(`${query.trim()}\0${knobsHash(knobs)}`);
}

export async function getSearchCache(
  db: SqlClient,
  query: string,
  knobs: SearchKnobs,
): Promise<{ hits: QueryHit[]; knobsHash: string } | null> {
  try {
    const kh = knobsHash(knobs);
    const key = cacheKey(query, knobs);
    const r = await db.query<{ knobs_hash: string; response_json: string }>(
      `SELECT knobs_hash, response_json FROM search_cache WHERE cache_key = $1`,
      [key],
    );
    const row = r.rows[0];
    if (!row || row.knobs_hash !== kh) return null;
    const hits = JSON.parse(row.response_json) as QueryHit[];
    if (!Array.isArray(hits)) return null;
    return { hits, knobsHash: kh };
  } catch {
    return null;
  }
}

export async function setSearchCache(
  db: SqlClient,
  query: string,
  knobs: SearchKnobs,
  hits: QueryHit[],
): Promise<void> {
  try {
    const kh = knobsHash(knobs);
    const key = cacheKey(query, knobs);
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO search_cache (cache_key, knobs_hash, response_json, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cache_key) DO UPDATE SET
         knobs_hash = EXCLUDED.knobs_hash,
         response_json = EXCLUDED.response_json,
         created_at = EXCLUDED.created_at`,
      [key, kh, JSON.stringify(hits), now],
    );
  } catch {
    /* fail-open：缓存写失败不影响查询 */
  }
}

/** 写入后失效查询缓存（防旧结果）。 */
export async function invalidateSearchCache(db: SqlClient): Promise<void> {
  try {
    await db.exec(`DELETE FROM search_cache`);
  } catch {
    /* fail-open */
  }
}
