export type IndexEngineId = "pglite" | "postgres";

/** PGlite / node-postgres 共用的最小 SQL 面（P5.7 IndexEngine）。 */
export interface SqlClient {
  readonly engine: IndexEngineId;
  /** postgres 上探测 pgvector；pglite 为 false（语义臂走 BYTEA 余弦） */
  readonly pgvector: boolean;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export function parseIndexEngine(raw: string | undefined): IndexEngineId {
  const v = (raw ?? "pglite").trim().toLowerCase();
  if (v === "postgres" || v === "postgresql" || v === "pg") return "postgres";
  if (v === "pglite" || v === "") return "pglite";
  return "pglite";
}

export function isKnownIndexEngine(raw: string | undefined): boolean {
  const v = (raw ?? "pglite").trim().toLowerCase();
  return v === "pglite" || v === "" || v === "postgres" || v === "postgresql" || v === "pg";
}
