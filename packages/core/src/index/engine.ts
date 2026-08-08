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
    await ensureSchema(db);
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

const ENTITY_REGISTRY_DDL = `CREATE TABLE IF NOT EXISTS entity_registry (
  brain_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  canonical_slug TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brain_id, slug)
);`;

/** 旧库 slug-PK → (brain_id, slug) PK；缺列则重建（可丢索引，文件可 rebuild）。 */
async function migrateEntityRegistry(db: PGlite): Promise<void> {
  try {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'entity_registry'`,
    );
    if (cols.rows.length === 0) {
      await db.exec(ENTITY_REGISTRY_DDL);
      return;
    }
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (!names.has("brain_id")) {
      await db.exec(`DROP TABLE IF EXISTS entity_registry CASCADE`);
      await db.exec(ENTITY_REGISTRY_DDL);
    }
  } catch {
    await db.exec(`DROP TABLE IF EXISTS entity_registry CASCADE`);
    await db.exec(ENTITY_REGISTRY_DDL);
  }
}

export async function ensureSchema(db: PGlite): Promise<void> {
  const sql = await Bun.file(join(import.meta.dir, "schema.sql")).text();
  await db.exec(sql);
  await migrateEntityRegistry(db);
}

/** 仅清除指定 brain 的索引行，保留其他 brain（多 brain 安全）。 */
export async function clearBrainIndex(db: PGlite, brainId: string): Promise<void> {
  const prefix = `brains/${brainId}/%`;
  await db.query(`DELETE FROM chunks WHERE path LIKE $1`, [prefix]);
  await db.query(`DELETE FROM pages WHERE brain_id = $1`, [brainId]);
  await db.query(`DELETE FROM links WHERE brain_id = $1`, [brainId]);
  try {
    await db.query(`DELETE FROM entity_registry WHERE brain_id = $1`, [brainId]);
  } catch {
    /* 旧表无 brain_id 时由 migrate 处理 */
  }
}
