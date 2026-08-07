export { openPglite, ensureSchema } from "./engine.ts";
export type { IndexConnection } from "./engine.ts";
export { syncPage, syncEntity, syncAll, chunkText, PAGE_COLS } from "./sync.ts";
export type { SyncOptions } from "./sync.ts";
export { rebuildIndex } from "./rebuild.ts";
export type { RebuildIndexOptions } from "./rebuild.ts";
export { pgliteIndexHooks } from "./hooks.ts";
export { readIndexMeta, writeIndexMeta, metaPath, readEmbeddingMeta, writeEmbeddingMeta, embeddingMetaPath } from "./meta.ts";
export type { IndexMeta, EmbeddingMeta } from "./meta.ts";
