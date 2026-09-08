import type { SqlClient } from "./sql.ts";

/** P14.4：HNSW 参数（锁死；与实测一致 m=16/ef_construction=64）。 */
export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 64;
/** P14.4：HNSW 候选放大（max-pool 按篇聚合，候选取 limit×倍数保召回，下限保底）。 */
export const HNSW_CANDIDATE_MULT = 10;
export const HNSW_CANDIDATE_MIN = 50;

/** 向量转 pgvector 文本格式（`$1::vector` 强转用）。 */
export function vectorText(vec: ArrayLike<number>): string {
  return `[${Array.from(vec, (v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}

/**
 * P14.4：确保 vector 扩展 + embedding_vec 列 + HNSW 索引（幂等）。
 * HNSW 要求列带固定维度，故列类型为 `vector(dims)`；换 provider 致 dims 变时删列重建
 * （上层 `embeddingMetaMismatch → rebuild` 已保证单 provider，一次性迁移）。
 * 扩展缺失（postgres 未装 pgvector 等）→ false，调用方回退暴力 cosine。
 */
export async function ensureVectorIndex(db: SqlClient, dims: number): Promise<boolean> {
  if (!Number.isInteger(dims) || dims <= 0) return false;
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector`);
    const existing = await db.query<{ t: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'chunks' AND a.attname = 'embedding_vec'`,
    );
    const cur = existing.rows[0]?.t ?? "";
    if (cur && cur !== `vector(${dims})`) {
      await db.exec(`DROP INDEX IF EXISTS chunks_embedding_hnsw`);
      await db.query(`ALTER TABLE chunks DROP COLUMN embedding_vec`);
    }
    await db.query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(${dims})`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding_vec vector_cosine_ops) WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION})`,
    );
    return true;
  } catch {
    return false;
  }
}
