import type { SqlClient } from "./sql.ts";

/**
 * P14.2：全库统计按 brain 分行批量刷（n/avgdl）。
 * 只在 compile 批量点 / rebuild-index 调用；capture 热路径不调（读旧值可用）。
 * 失败由调用方 fail-open（读旧值 + 查询侧 fallback 公式）。
 */
export async function refreshCorpusStats(
  db: SqlClient,
  brainId: string,
): Promise<{ n: number; avgdl: number }> {
  const r = await db.query<{ n: string | number; avgdl: string | number | null }>(
    `SELECT COUNT(*) AS n, COALESCE(AVG(doc_len), 0) AS avgdl FROM pages WHERE brain_id = $1`,
    [brainId],
  );
  const n = Number(r.rows[0]?.n ?? 0);
  const avgdl = Number(r.rows[0]?.avgdl ?? 0);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO corpus_stats (brain_id, n, avgdl, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (brain_id) DO UPDATE SET n = EXCLUDED.n, avgdl = EXCLUDED.avgdl, updated_at = EXCLUDED.updated_at`,
    [brainId, n, avgdl, now],
  );
  return { n, avgdl };
}
