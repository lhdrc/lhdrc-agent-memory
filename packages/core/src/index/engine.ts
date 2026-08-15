import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { readSchemaSql } from "../util/here.ts";
import type { SqlClient, IndexEngineId } from "./sql.ts";
import { isKnownIndexEngine, parseIndexEngine } from "./sql.ts";
import { openPostgresSqlClient } from "./postgres.ts";

export type { SqlClient, IndexEngineId } from "./sql.ts";

export interface IndexConnection {
  repoRoot: string;
  db: SqlClient;
  engine: IndexEngineId;
  close(): Promise<void>;
}

function wrapPglite(raw: PGlite): SqlClient {
  return {
    engine: "pglite",
    pgvector: false,
    query: <T>(sql: string, params?: unknown[]) => raw.query<T>(sql, params as never),
    exec: (sql: string) => raw.exec(sql),
    close: async () => {
      try {
        await raw.close();
      } catch {
        /* 忽略关闭错误 */
      }
    },
  };
}

async function openPgliteEngine(repoRoot: string, dataDir: string): Promise<SqlClient> {
  let raw: PGlite;
  try {
    raw = new PGlite(dataDir);
    if ("waitReady" in raw && typeof (raw as { waitReady?: Promise<unknown> }).waitReady?.then === "function") {
      await (raw as { waitReady?: Promise<unknown> }).waitReady;
    }
  } catch (e) {
    throw new MemoryError(ErrorCodes.INDEX, `PGLite 打开失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const db = wrapPglite(raw);
  await ensureSchema(db);
  return db;
}

/**
 * 按 memory.yml `index.engine` 打开索引（P5.7）。
 * 默认 pglite；postgres 需 DF_MEMORY_DATABASE_URL，失败不回退。
 */
export async function openIndex(repoRoot: string): Promise<IndexConnection> {
  const cfg = await loadRepoConfig(repoRoot);
  const rawEngine = cfg.index.engine;
  if (!isKnownIndexEngine(rawEngine)) {
    throw new MemoryError(
      ErrorCodes.INDEX,
      `未知 index.engine: ${rawEngine}（支持 pglite | postgres）`,
    );
  }
  const engine = parseIndexEngine(rawEngine);
  let db: SqlClient;
  try {
    if (engine === "postgres") {
      db = await openPostgresSqlClient();
      await ensureSchema(db);
    } else {
      db = await openPgliteEngine(repoRoot, join(repoRoot, cfg.index.path));
    }
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.INDEX, `打开索引失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    repoRoot,
    db,
    engine: db.engine,
    close: () => db.close(),
  };
}

/** 兼容旧名：按配置分发，不再强制 PGLite。 */
export async function openPglite(repoRoot: string): Promise<IndexConnection> {
  return openIndex(repoRoot);
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
async function migrateEntityRegistry(db: SqlClient): Promise<void> {
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

export async function ensureSchema(db: SqlClient): Promise<void> {
  const sql = await readSchemaSql(import.meta.url);
  await db.exec(sql);
  await migrateEntityRegistry(db);
}

/** 仅清除指定 brain 的索引行，保留其他 brain（多 brain 安全）。 */
export async function clearBrainIndex(db: SqlClient, brainId: string): Promise<void> {
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
