import { openIndex, ensureSchema } from "../index/engine.ts";
import { hybridQuery } from "../retrieve/hybrid.ts";
import type { ExistingMemoryLine } from "./parse.ts";

/** P6.6：提取前只读已有标题；失败当空，不阻断 compile。 */
export async function prefetchExistingMemories(opts: {
  repoRoot: string;
  brainId: string;
  query: string;
  topn: number;
}): Promise<ExistingMemoryLine[]> {
  if (opts.topn <= 0) return [];
  const q = opts.query.trim();
  if (!q) return [];
  try {
    const conn = await openIndex(opts.repoRoot);
    try {
      await ensureSchema(conn.db);
      const hits = await hybridQuery(conn.db, {
        brainId: opts.brainId,
        query: q,
        limit: opts.topn,
        repoRoot: opts.repoRoot,
        skipCache: true,
      });
      return hits.slice(0, opts.topn).map((h) => ({
        title: (h.title || "").trim() || "untitled",
        snippet: (h.abstract || h.snippet || "").replace(/\s+/g, " ").trim(),
      }));
    } finally {
      await conn.close();
    }
  } catch {
    return [];
  }
}
