import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";

export interface IndexMeta {
  schemaVersion: number;
  lastSyncAt: string | null;
  fileCount: number;
  engine?: string;
}

export function metaPath(repoRoot: string): string {
  return join(repoRoot, ".dfmemory", "index-meta.json");
}

export async function readIndexMeta(repoRoot: string): Promise<IndexMeta> {
  try {
    const raw = await readFile(metaPath(repoRoot), "utf8");
    const data = JSON.parse(raw) as Partial<IndexMeta>;
    return {
      schemaVersion: data.schemaVersion ?? 1,
      lastSyncAt: data.lastSyncAt ?? null,
      fileCount: data.fileCount ?? 0,
      engine: data.engine ?? "pglite",
    };
  } catch {
    return { schemaVersion: 1, lastSyncAt: null, fileCount: 0, engine: "pglite" };
  }
}

export async function writeIndexMeta(repoRoot: string, meta: IndexMeta): Promise<void> {
  await writeFile(metaPath(repoRoot), JSON.stringify(meta, null, 2), "utf8");
}
