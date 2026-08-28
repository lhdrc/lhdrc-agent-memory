/** P12.1：长驻进程按仓缓存语义臂向量。一次性 CLI 退出则无增益。 */

export interface CachedEmbedChunk {
  id: string;
  path: string;
  vec: Float32Array;
}

interface CacheEntry {
  fingerprint: string;
  chunks: CachedEmbedChunk[];
}

const cache = new Map<string, CacheEntry>();

export function normalizeRepoRootKey(repoRoot: string): string {
  return repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function embedCacheStoreKey(repoRoot: string, brainId: string, filterKey: string): string {
  return `${normalizeRepoRootKey(repoRoot)}::${brainId}::${filterKey}`;
}

export function semanticFilterKey(opts: {
  sourceId?: string;
  schemaType?: string;
  excludeSchemaTypes?: string[];
  excludeSidecars?: boolean;
  pathPrefix?: string;
  pathContains?: string;
}): string {
  return JSON.stringify({
    sourceId: opts.sourceId ?? "",
    schemaType: opts.schemaType ?? "",
    excludeSchemaTypes: opts.excludeSchemaTypes ?? [],
    excludeSidecars: Boolean(opts.excludeSidecars),
    pathPrefix: opts.pathPrefix ?? "",
    pathContains: opts.pathContains ?? "",
  });
}

export function getEmbeddingCache(key: string, fingerprint: string): CachedEmbedChunk[] | null {
  const hit = cache.get(key);
  if (!hit || hit.fingerprint !== fingerprint) return null;
  return hit.chunks;
}

export function setEmbeddingCache(key: string, fingerprint: string, chunks: CachedEmbedChunk[]): void {
  cache.set(key, { fingerprint, chunks });
}

export function invalidateEmbeddingCache(repoRoot?: string): void {
  if (!repoRoot) {
    cache.clear();
    return;
  }
  const prefix = `${normalizeRepoRootKey(repoRoot)}::`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
