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

export interface EmbeddingMeta {
  provider: string;
  dims: number;
  model: string;
}

export function embeddingMetaPath(repoRoot: string): string {
  return join(repoRoot, ".dfmemory", "embedding-meta.json");
}

export async function readEmbeddingMeta(repoRoot: string): Promise<EmbeddingMeta | null> {
  try {
    const raw = await readFile(embeddingMetaPath(repoRoot), "utf8");
    return JSON.parse(raw) as EmbeddingMeta;
  } catch {
    return null;
  }
}

export async function writeEmbeddingMeta(repoRoot: string, meta: EmbeddingMeta): Promise<void> {
  await writeFile(embeddingMetaPath(repoRoot), JSON.stringify(meta, null, 2), "utf8");
}
