import type { IndexSyncHooks } from "../write/hooks.ts";
import { createEmbeddingProvider } from "../embed/factory.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { openIndex, ensureSchema } from "./engine.ts";
import { syncPage, syncEntity } from "./sync.ts";
import { readIndexMeta, writeIndexMeta } from "./meta.ts";
import { invalidateSearchCache } from "../retrieve/cache.ts";

async function resolveSyncOptions(repoRoot: string) {
  const cfg = await loadRepoConfig(repoRoot);
  if (cfg.embedding.provider === "off") return undefined;
  const embedder = createEmbeddingProvider(cfg.embedding);
  return { embedder, embeddingModel: cfg.embedding.model };
}

/** M3 + P2.1a：文件落盘后增量同步 + 刷新 index-meta（D18：不依赖 git commit）。 */
export const pgliteIndexHooks: IndexSyncHooks = {
  async onFilesWritten(repoRoot, paths) {
    const syncOpts = await resolveSyncOptions(repoRoot);
    const conn = await openIndex(repoRoot);
    try {
      await ensureSchema(conn.db);
      for (const p of paths) {
        if (p.includes("/entities/")) {
          await syncEntity(conn.db, repoRoot, p);
        } else if (
          p.endsWith(".md") &&
          (p.includes("/sources/") || p.includes("/experiences/") || p.includes("/skills/"))
        ) {
          await syncPage(conn.db, repoRoot, p, syncOpts);
        }
      }
      await invalidateSearchCache(conn.db);
      const meta = await readIndexMeta(repoRoot);
      const count = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
      await writeIndexMeta(repoRoot, {
        ...meta,
        lastSyncAt: new Date().toISOString(),
        fileCount: Number(count.rows[0]?.n ?? 0),
        engine: conn.db.engine,
      });
    } finally {
      await conn.close();
    }
  },
};
