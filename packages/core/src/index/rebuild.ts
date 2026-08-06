import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { openPglite, ensureSchema } from "./engine.ts";
import { syncAll } from "./sync.ts";

/** 全量重建：DROP 全表 → 重跑 DDL → 全量扫描。 */
export async function rebuildIndex(repoRoot: string): Promise<{ fileCount: number }> {
  const cfg = await loadRepoConfig(repoRoot);
  const conn = await openPglite(repoRoot);
  try {
    await conn.db.exec(`DROP TABLE IF EXISTS chunks, entity_registry, pages`);
    await ensureSchema(conn.db);
    return await syncAll(conn.db, repoRoot, cfg.brain_id);
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `rebuild-index 失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await conn.close();
  }
}
