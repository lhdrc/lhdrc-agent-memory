import type { SqlClient } from "../index/sql.ts";
import { bytesToFloat32, cosineSimilarity } from "../embed/cosine.ts";
import { makeSnippet } from "./query.ts";
import { appendPageFilters } from "./filters.ts";
import type { RankedHit } from "./rrf.ts";
import { PGVECTOR_WARN } from "../index/postgres.ts";

let warnedSkipSemantic = false;

export interface SemanticArmOptions {
  brainId: string;
  queryVec: number[];
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
}

/**
 * 语义臂：brute-force cosine vs chunks.embedding（非 null）→ 同 path max-pool → top limit。
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

  const sql = `
    SELECT c.path, c.text, c.embedding, p.title
    FROM chunks c
    INNER JOIN pages p ON p.path = c.path
    WHERE p.status = 'active'
      AND p.brain_id = $1
      AND c.embedding IS NOT NULL
      ${extraWhere}`;

  const result = await db.query<{
    path: string;
    text: string;
    embedding: Uint8Array | Buffer;
    title: string;
  }>(sql, params);

  const pathBest = new Map<string, { score: number; text: string; title: string }>();

  for (const row of result.rows) {
    const vec = bytesToFloat32(row.embedding);
    const score = cosineSimilarity(opts.queryVec, vec);
    const prev = pathBest.get(row.path);
    if (!prev || score > prev.score) {
      pathBest.set(row.path, { score, text: String(row.text), title: String(row.title) });
    }
  }

  const ranked: RankedHit[] = [];
  for (const [path, { score, text, title }] of pathBest) {
    ranked.push({
      path,
      score,
      title,
      snippet: opts.query ? makeSnippet(text, opts.query) : text.slice(0, 160),
      evidence: ["semantic"],
    });
  }

  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
  return ranked.slice(0, Math.max(1, Math.floor(opts.limit)));
}
