import {
  MemoryError,
  ErrorCodes,
  openPglite,
  thinkQuery,
  createEmbeddingProvider,
  loadRepoConfig,
  loadPack,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function thinkCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [{ name: "json", type: "boolean" }]);
  const text = o._.join(" ").trim();
  if (!text) {
    throw new MemoryError(ErrorCodes.USAGE, "think 需要一个查询文本");
  }
  const ctx = await loadContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const embedder =
    cfg.embedding.provider !== "off" ? createEmbeddingProvider(cfg.embedding) : null;
  let intentLexicon: Record<string, string[]> | null = null;
  try {
    const pack = await loadPack(cfg.schema_pack);
    intentLexicon = pack.intent_lexicon ?? null;
  } catch {
    /* pack 缺失时用内置词表 */
  }
  const conn = await openPglite(ctx.repoRoot);
  try {
    const result = await thinkQuery(conn.db, {
      brainId: ctx.brainId,
      query: text,
      repoRoot: ctx.repoRoot,
      search: cfg.search,
      embedder,
      intentLexicon,
    });
    if (!ctx.auth.allowedSources.includes("*")) {
      const allow = new Set(ctx.auth.allowedSources);
      result.notes = result.notes.filter((h) => {
        const parts = h.path.replace(/\\/g, "/").split("/");
        const si = parts.indexOf("sources");
        const src = si >= 0 ? parts[si + 1] : undefined;
        return !src || allow.has(src);
      });
    }
    if (o.json) {
      console.log(JSON.stringify(result));
    } else {
      if (result.hints.includes("cold_start")) {
        console.log("cold_start: 记忆库为空或无相关命中，可先 capture / refine。");
      }
      for (const [label, items] of [
        ["skills", result.skills],
        ["experiences", result.experiences],
        ["notes", result.notes],
      ] as const) {
        console.log(`# ${label} (${items.length})`);
        for (const h of items) {
          console.log(`- ${h.title}  ${h.path}`);
        }
      }
    }
    return 0;
  } finally {
    await conn.close();
  }
}
