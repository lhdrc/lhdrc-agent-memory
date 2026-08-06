import type { IndexSyncHooks } from "../write/hooks.ts";
import { openPglite, ensureSchema } from "./engine.ts";
import { syncPage, syncEntity } from "./sync.ts";
import { readIndexMeta, writeIndexMeta } from "./meta.ts";

/** M3：文件落盘后增量同步 + 刷新 index-meta（D18：不依赖 git commit）。 */
export const pgliteIndexHooks: IndexSyncHooks = {
  async onFilesWritten(repoRoot, paths) {
    const conn = await openPglite(repoRoot);
    try {
      await ensureSchema(conn.db);
      for (const p of paths) {
        if (p.includes("/entities/")) {
          await syncEntity(conn.db, repoRoot, p);
        } else if (p.endsWith(".md") && p.includes("/sources/")) {
          await syncPage(conn.db, repoRoot, p);
        }
      }
      const meta = await readIndexMeta(repoRoot);
      const count = await conn.db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
      await writeIndexMeta(repoRoot, {
        ...meta,
        lastSyncAt: new Date().toISOString(),
        fileCount: Number(count.rows[0]?.n ?? 0),
        engine: "pglite",
      });
    } finally {
      await conn.close();
    }
  },
};
