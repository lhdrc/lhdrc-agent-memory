import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadRepoConfig } from "../repo/config.ts";

export interface IndexConnection {
  repoRoot: string;
  db: PGlite;
  close(): Promise<void>;
}

export async function openPglite(repoRoot: string): Promise<IndexConnection> {
  const cfg = await loadRepoConfig(repoRoot);
  const dataDir = join(repoRoot, cfg.index.path);
  let db: PGlite;
  try {
    db = new PGlite(dataDir);
    if ("waitReady" in db && typeof (db as { waitReady?: Promise<unknown> }).waitReady?.then === "function") {
      await (db as { waitReady?: Promise<unknown> }).waitReady;
    }
  } catch (e) {
    throw new MemoryError(ErrorCodes.INDEX, `PGLite 打开失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    repoRoot,
    db,
    close: async () => {
      try {
        await db.close();
      } catch {
        /* 忽略关闭错误 */
      }
    },
  };
}

export async function ensureSchema(db: PGlite): Promise<void> {
  const sql = await Bun.file(join(import.meta.dir, "schema.sql")).text();
  await db.exec(sql);
}
