import { MemoryError, ErrorCodes } from "../errors.ts";
import { resolveEmbedder } from "../embed/factory.ts";
import { float32ToBytes } from "../embed/cosine.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { listBrains } from "../repo/brain.ts";
import { openIndex, ensureSchema, clearBrainIndex } from "./engine.ts";
import { syncAll, type SyncOptions } from "./sync.ts";
import { invalidateSearchCache } from "../retrieve/cache.ts";
import { invalidateEmbeddingCache } from "../retrieve/embed-cache.ts";
import { writeEmbeddingMeta } from "./meta.ts";
import type { EmbeddingProvider } from "../embed/types.ts";
import type { SqlClient } from "./sql.ts";

export interface RebuildIndexOptions {
  /** 显式重算向量（CLI: rebuild-index --embeddings） */
  embeddings?: boolean;
  /**
   * P12.1：只填 embedding IS NULL，不清 pages。
   * 与 embeddings 互斥。
   */
  pendingEmbeddings?: boolean;
  /**
   * 重建仓内全部 brain（默认 false：只重建指定/默认 brain，不清其他 brain 索引）。
   * true 时对每个 brain 执行 clear + syncAll。
   */
  allBrains?: boolean;
}

const PENDING_BATCH = 32;

/**
 * 重建索引：按 brain 清除行后重扫文件（不 DROP 共享表，避免抹掉其他 brain）。
 * @param brainId 活跃 brain；缺省回退 memory.yml 的 brain_id
 */
export async function rebuildIndex(
  repoRoot: string,
  brainId?: string,
  opts?: RebuildIndexOptions,
): Promise<{ fileCount: number; pendingEmbedded?: number }> {
  if (opts?.embeddings && opts.pendingEmbeddings) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      "rebuild-index 不能同时使用 --embeddings 与 --pending-embeddings",
    );
  }

  const cfg = await loadRepoConfig(repoRoot);
  const id = brainId ?? cfg.brain_id;

  if (opts?.pendingEmbeddings) {
    return runPendingEmbeddings(repoRoot, id, cfg);
  }

  const shouldEmbed = opts?.embeddings === true || cfg.embedding.provider !== "off";
  let syncOpts: SyncOptions | undefined;
  if (shouldEmbed && cfg.embedding.provider !== "off") {
    const resolved = resolveEmbedder(cfg.embedding, { strict: opts?.embeddings === true });
    syncOpts = {
      embedder: resolved.embedder,
      embeddingModel: cfg.embedding.model,
    };
  }
  const conn = await openIndex(repoRoot);
  try {
    await ensureSchema(conn.db);
    await invalidateSearchCache(conn.db);

    const targets = opts?.allBrains
      ? (await listBrains(repoRoot)).map((b) => b.id)
      : [id];
    if (targets.length === 0) targets.push(id);

    let fileCount = 0;
    for (const bid of targets) {
      await clearBrainIndex(conn.db, bid);
      const r = await syncAll(conn.db, repoRoot, bid, syncOpts);
      fileCount += r.fileCount;
    }
    const count = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
    invalidateEmbeddingCache(repoRoot);
    return { fileCount: Number(count.rows[0]?.n ?? fileCount) };
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `rebuild-index 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn.close();
  }
}

async function runPendingEmbeddings(
  repoRoot: string,
  brainId: string,
  cfg: Awaited<ReturnType<typeof loadRepoConfig>>,
): Promise<{ fileCount: number; pendingEmbedded: number }> {
  if (cfg.embedding.provider === "off") {
    throw new MemoryError(ErrorCodes.DISABLED, "rebuild-index --pending-embeddings 需要 embedding.provider ≠ off");
  }
  const resolved = resolveEmbedder(cfg.embedding, { strict: true });
  const conn = await openIndex(repoRoot);
  try {
    await ensureSchema(conn.db);
    await invalidateSearchCache(conn.db);
    const pendingEmbedded = await embedPendingChunks(
      conn.db,
      repoRoot,
      brainId,
      resolved.embedder,
      cfg.embedding.model,
    );
    const count = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
    invalidateEmbeddingCache(repoRoot);
    return { fileCount: Number(count.rows[0]?.n ?? 0), pendingEmbedded };
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `rebuild-index 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn.close();
  }
}

export async function embedPendingChunks(
  db: SqlClient,
  repoRoot: string,
  brainId: string,
  embedder: EmbeddingProvider,
  embeddingModel?: string,
): Promise<number> {
  const pending = await db.query<{ id: string; text: string }>(
    `SELECT c.id, c.text FROM chunks c
     INNER JOIN pages p ON p.path = c.path
     WHERE p.brain_id = $1 AND c.embedding IS NULL
     ORDER BY c.id`,
    [brainId],
  );
  const rows = pending.rows;
  let n = 0;
  for (let i = 0; i < rows.length; i += PENDING_BATCH) {
    const slice = rows.slice(i, i + PENDING_BATCH);
    const vectors = await embedder.embed(slice.map((s) => String(s.text)));
    for (let j = 0; j < slice.length; j++) {
      const bytes = float32ToBytes(vectors[j]!);
      await db.query(`UPDATE chunks SET embedding = $1 WHERE id = $2`, [bytes, slice[j]!.id]);
    }
    n += slice.length;
  }
  if (n > 0) {
    await writeEmbeddingMeta(repoRoot, {
      provider: embedder.id,
      dims: embedder.dims,
      model: embeddingModel ?? embedder.id,
    });
  }
  return n;
}
