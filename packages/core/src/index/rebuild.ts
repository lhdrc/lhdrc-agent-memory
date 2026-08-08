import { MemoryError, ErrorCodes } from "../errors.ts";
import { createEmbeddingProvider } from "../embed/factory.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { listBrains } from "../repo/brain.ts";
import { openPglite, ensureSchema, clearBrainIndex } from "./engine.ts";
import { syncAll, type SyncOptions } from "./sync.ts";
import { invalidateSearchCache } from "../retrieve/cache.ts";

export interface RebuildIndexOptions {
  /** 显式重算向量（CLI: rebuild-index --embeddings） */
  embeddings?: boolean;
  /**
   * 重建仓内全部 brain（默认 false：只重建指定/默认 brain，不清其他 brain 索引）。
   * true 时对每个 brain 执行 clear + syncAll。
   */
  allBrains?: boolean;
}

/**
 * 重建索引：按 brain 清除行后重扫文件（不 DROP 共享表，避免抹掉其他 brain）。
 * @param brainId 活跃 brain；缺省回退 memory.yml 的 brain_id
 */
export async function rebuildIndex(
  repoRoot: string,
  brainId?: string,
  opts?: RebuildIndexOptions,
): Promise<{ fileCount: number }> {
  const cfg = await loadRepoConfig(repoRoot);
  const id = brainId ?? cfg.brain_id;
  const shouldEmbed = opts?.embeddings === true || cfg.embedding.provider !== "off";
  let syncOpts: SyncOptions | undefined;
  if (shouldEmbed && cfg.embedding.provider !== "off") {
    syncOpts = {
      embedder: createEmbeddingProvider(cfg.embedding),
      embeddingModel: cfg.embedding.model,
    };
  }
  const conn = await openPglite(repoRoot);
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
    // syncAll 的 fileCount 是全表 pages 计数；多 brain 循环后取最终全表数
    const count = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
    return { fileCount: Number(count.rows[0]?.n ?? fileCount) };
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `rebuild-index 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn.close();
  }
}
