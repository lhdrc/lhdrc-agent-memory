import { MemoryError, ErrorCodes } from "../errors.ts";
import type { SqlClient } from "./sql.ts";

const PGVECTOR_WARN =
  "[index] pgvector 不可用，语义臂跳过；BM25 仍可用。可改用 pgvector 镜像或单机 PGLite。";

let warnedNoVector = false;

export function postgresDatabaseUrl(): string | undefined {
  const u = process.env.DF_MEMORY_DATABASE_URL?.trim();
  return u || undefined;
}

export function assertPostgresUrl(url: string): void {
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new MemoryError(
      ErrorCodes.INDEX,
      `无效的 DF_MEMORY_DATABASE_URL（需要 postgres:// 或 postgresql://）: ${redactUrl(url)}`,
    );
  }
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DSN)";
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new MemoryError(ErrorCodes.INDEX, `非法 Postgres schema 名: ${name}`);
  }
  return `"${name}"`;
}

export async function openPostgresSqlClient(): Promise<SqlClient> {
  const url = postgresDatabaseUrl();
  if (!url) {
    throw new MemoryError(
      ErrorCodes.INDEX,
      "index.engine=postgres 需要设置 DF_MEMORY_DATABASE_URL（postgres://user:pass@host:port/db）",
    );
  }
  assertPostgresUrl(url);

  let Client: typeof import("pg").Client;
  try {
    ({ Client } = await import("pg"));
  } catch (e) {
    throw new MemoryError(
      ErrorCodes.INDEX,
      `无法加载 pg 驱动: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch (e) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    throw new MemoryError(
      ErrorCodes.INDEX,
      `Postgres 连接失败（DF_MEMORY_DATABASE_URL=${redactUrl(url)}）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const schema = process.env.DF_MEMORY_PG_SCHEMA?.trim();
  if (schema) {
    const ident = quoteIdent(schema);
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident}`);
      await client.query(`SET search_path TO ${ident}, public`);
    } catch (e) {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      throw new MemoryError(
        ErrorCodes.INDEX,
        `Postgres schema 失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let pgvector = false;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    pgvector = true;
  } catch {
    pgvector = false;
    if (!warnedNoVector) {
      warnedNoVector = true;
      console.warn(PGVECTOR_WARN);
    }
  }

  return {
    engine: "postgres",
    pgvector,
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async close() {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    },
  };
}

export { PGVECTOR_WARN };
