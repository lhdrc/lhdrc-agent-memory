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
    hnswResultCache.clear();
    return;
  }
  const prefix = `${normalizeRepoRootKey(repoRoot)}::`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
  for (const k of [...hnswResultCache.keys()]) {
    if (k.startsWith(prefix)) hnswResultCache.delete(k);
  }
}

/** P14.4：HNSW 结果缓存（按 query 指纹键，避免向量暖缓存污染不同查询的召回）。 */
interface HnswResultEntry {
  fp: string;
  hits: unknown[];
}

const hnswResultCache = new Map<string, HnswResultEntry>();
const HNSW_RESULT_CACHE_MAX = 100;

/** 查询向量 FNV 指纹（含全部维度，防缓存串味）。 */
export function queryVecFingerprint(vec: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  h = (h ^ vec.length) >>> 0;
  const n = vec.length;
  for (let i = 0; i < n; i++) {
    const v = Math.round(Number(vec[i]) * 1e6);
    h ^= v & 0xffffffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${n}:${(h >>> 0).toString(16)}`;
}

export function hnswResultKey(
  repoRoot: string,
  brainId: string,
  filterKey: string,
  limit: number,
  vecFp: string,
): string {
  return `${normalizeRepoRootKey(repoRoot)}::${brainId}::${filterKey}::limit${limit}::${vecFp}`;
}

export function getHnswResultCache<T>(key: string, fp: string): T[] | null {
  const hit = hnswResultCache.get(key);
  if (!hit || hit.fp !== fp) return null;
  return hit.hits as T[];
}

export function setHnswResultCache(key: string, fp: string, hits: unknown[]): void {
  if (hnswResultCache.size >= HNSW_RESULT_CACHE_MAX) {
    const oldest = hnswResultCache.keys().next();
    if (!oldest.done) hnswResultCache.delete(oldest.value);
  }
  hnswResultCache.set(key, { fp, hits });
}
