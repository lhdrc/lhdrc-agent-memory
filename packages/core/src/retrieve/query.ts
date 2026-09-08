import type { SqlClient } from "../index/sql.ts";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { cleanForIndex } from "./clean.ts";
import { tokenizeMixed } from "./tokenize.ts";
import { appendPageFilters } from "./filters.ts";

export type { PageFilterOptions } from "./filters.ts";
export { assertExclusiveSchemaFilters, appendPageFilters } from "./filters.ts";

export interface QueryOptions {
  brainId: string;
  query: string;
  limit?: number;
  sourceId?: string;
  /** P2.2：按 schema_type 过滤 */
  schemaType?: string;
  /** P8.2：排除 schema_type（与 schemaType 互斥） */
  excludeSchemaTypes?: string[];
  /** P8.2：排除 *.overview.md / *.abstract.md 侧车 */
  excludeSidecars?: boolean;
  /** P11.1 搜前路径收缩 */
  pathPrefix?: string;
  pathContains?: string;
}

export interface QueryHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  evidence: string[];
  /** P5.2：frontmatter abstract；snippet 优先用它 */
  abstract?: string;
  /** P5.3 内部：用于 hotness */
  updatedAt?: string;
  /** P8.2：层标注（annotateHits / 路径推断） */
  schema_type?: string;
  eta_score?: number;
  support?: number;
  source_paths?: string[];
}

export function makeSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const idx = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (idx >= 0) {
    const start = Math.max(0, idx - 40);
    const prefix = start > 0 ? "…" : "";
    const suffix = start + 160 < normalized.length ? "…" : "";
    return `${prefix}${normalized.slice(start, start + 160)}${suffix}`;
  }
  return normalized.slice(0, 160) + (normalized.length > 160 ? "…" : "");
}

/** P14.2：半 BM25 常数（锁死；阶段二换真 tf 前不动）。 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * P14.2：TF 饱和 × 长度支点归一（SQL 内同公式；ts_rank 输出暂代 tf）。
 * avgdl 缺失/非法时原样返回，调用方回退旧 `len^0.3` 公式。
 */
export function bm25Saturate(raw: number, dl: number, avgdl: number): number {
  if (!(raw > 0) || !(avgdl > 0) || !(dl >= 0)) return raw;
  return (raw * (BM25_K1 + 1)) / (raw + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
}

/**
 * BM25 风格相关度查询：simple FTS + 中文 bigram + title/path 子串加权。
 * 默认排除 archived（specs/mvp/M3 §5.2）。
 * title/path 用 position(lower(...))，避免 ILIKE 把 %/_ 当通配符。
 */
export async function bm25Query(db: SqlClient, opts: QueryOptions): Promise<QueryHit[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const cleaned = cleanForIndex(q, "bm25");
  const { cjkBigrams: qng, enWords: enQ } = tokenizeMixed(cleaned);
  const limit = opts.limit ?? 10;

  // 查询入口保证 schema 存在（init 后 / 删 pglite 后直接 query）
  const { ensureSchema } = await import("../index/engine.ts");
  await ensureSchema(db);

  const pageFilters = appendPageFilters(opts, 7);
  const filterSql = pageFilters.clauses.length ? ` AND ${pageFilters.clauses.join(" AND ")}` : "";

  // P14.2：读 corpus_stats 支点；缺失/非法 → -1 → 回退旧 len^0.3 公式（fail-open）
  let avgdl = -1;
  try {
    const s = await db.query<{ avgdl: string | number | null }>(
      `SELECT avgdl FROM corpus_stats WHERE brain_id = $1`,
      [opts.brainId],
    );
    const v = Number(s.rows[0]?.avgdl ?? -1);
    if (Number.isFinite(v) && v > 0) avgdl = v;
  } catch {
    avgdl = -1;
  }

  const sql = `
SELECT * FROM (
  SELECT path, title,
    CASE WHEN $6 > 0 THEN
      -- P14.2：TF 饱和 × 长度支点（= bm25Saturate；ts_rank 暂代 tf）
      raw * ${(BM25_K1 + 1).toFixed(1)} / (raw + ${BM25_K1} * (${(1 - BM25_B).toFixed(2)} + ${BM25_B} * coalesce(doc_len, length(coalesce(body_text,'')) + 1) / $6))
    ELSE
      raw / power(length(coalesce(body_text,'')) + 1, 0.3)
    END AS score,
    body_text,
    frontmatter_json,
    aliases_json,
    updated_at
  FROM (
    SELECT path, title, body_text, frontmatter_json, aliases_json, updated_at, doc_len,
      (
        3.0 * ts_rank(to_tsvector('simple', coalesce(fts_title,'')), plainto_tsquery('simple', $1))
        + 1.5 * ts_rank(to_tsvector('simple', coalesce(fts_title,'')), phraseto_tsquery('simple', $1))
        + 1.0 * ts_rank(to_tsvector('simple', coalesce(fts_body,'')), plainto_tsquery('simple', $1))
        + 0.5 * ts_rank(to_tsvector('simple', coalesce(fts_body,'')), phraseto_tsquery('simple', $1))
        + 2.0 * ts_rank(to_tsvector('simple', coalesce(title_ngrams,'')), plainto_tsquery('simple', $2))
        + 0.8 * ts_rank(to_tsvector('simple', coalesce(body_ngrams,'')), plainto_tsquery('simple', $2))
        + 1.2 * ts_rank(to_tsvector('english', coalesce(en_title,'')), plainto_tsquery('english', $5))
        + 0.6 * ts_rank(to_tsvector('english', coalesce(en_body,'')), plainto_tsquery('english', $5))
        + CASE WHEN position(lower($3) in lower(coalesce(title,''))) > 0 THEN 2.5 ELSE 0 END
        + CASE WHEN position(lower($3) in lower(path)) > 0 THEN 1.5 ELSE 0 END
        + CASE WHEN position(lower($3) in lower(coalesce(aliases_json,''))) > 0 THEN 3.0 ELSE 0 END
      ) AS raw
    FROM pages
    WHERE status = 'active' AND brain_id = $4${filterSql}
  ) s
) ranked
WHERE score > 0
ORDER BY score DESC
LIMIT ${Math.max(1, Math.floor(limit))}`;

  const params: unknown[] = [cleaned, qng, q, opts.brainId, enQ, avgdl, ...pageFilters.params];

  let rows: Array<{
    path: string;
    title: string;
    score: number;
    body_text: string;
    frontmatter_json: string;
    aliases_json: string;
    updated_at: string;
  }>;
  try {
    const result = await db.query<{
      path: string;
      title: string;
      score: number;
      body_text: string;
      frontmatter_json: string;
      aliases_json: string;
      updated_at: string;
    }>(sql, params);
    rows = result.rows;
  } catch (e) {
    throw new MemoryError(ErrorCodes.INDEX, `查询失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out: QueryHit[] = [];
  for (const r of rows) {
    const evidence: string[] = ["keyword"];
    const title = String(r.title);
    if (containsFold(title, q)) evidence.push("title");
    if (r.path.toLowerCase().includes(q.toLowerCase())) evidence.push("path");
    if (containsFold(String(r.aliases_json ?? ""), q)) evidence.push("alias");
    const abstract = abstractFromFrontmatter(r.frontmatter_json);
    const snippetSrc = abstract || String(r.body_text);
    out.push({
      path: r.path,
      title,
      score: Number(r.score),
      snippet: makeSnippet(snippetSrc, q),
      evidence,
      ...(abstract ? { abstract } : {}),
      updatedAt: r.updated_at ? String(r.updated_at) : undefined,
    });
  }
  return out;
}

function containsFold(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function abstractFromFrontmatter(json: string | null | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    const a = typeof data.abstract === "string" ? data.abstract.trim() : "";
    return a || undefined;
  } catch {
    return undefined;
  }
}
