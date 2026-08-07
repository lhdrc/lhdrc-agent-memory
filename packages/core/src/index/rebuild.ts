import { MemoryError, ErrorCodes } from "../errors.ts";
import { createEmbeddingProvider } from "../embed/factory.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { openPglite, ensureSchema } from "./engine.ts";
import { syncAll, type SyncOptions } from "./sync.ts";

export interface RebuildIndexOptions {
  /** 显式重算向量（CLI: rebuild-index --embeddings） */
  embeddings?: boolean;
}

/**
 * 全量重建：DROP 全表 → 重跑 DDL → 全量扫描。
 * @param brainId 活跃 brain；缺省回退 memory.yml 的 brain_id（与 query 的 DF_MEMORY_BRAIN 对齐时由 CLI 传入）
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
    await conn.db.exec(`DROP TABLE IF EXISTS chunks, entity_registry, pages`);
    await ensureSchema(conn.db);
    return await syncAll(conn.db, repoRoot, id, syncOpts);
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `rebuild-index 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn.close();
  }
}
