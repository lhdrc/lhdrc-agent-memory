import {
  MemoryError,
  ErrorCodes,
  openPglite,
  hybridQueryDetailed,
  createEmbeddingProvider,
  loadRepoConfig,
  loadPack,
  assertSourceScope,
  assertPathScope,
  type SearchMode,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

const VALID_MODES = new Set<string>(["conservative", "balanced", "tokenmax"]);

export async function queryCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "limit", type: "string" },
    { name: "source", type: "string" },
    { name: "type", type: "string" },
    { name: "exclude-type", type: "string[]" },
    { name: "exclude-sidecars", type: "boolean" },
    { name: "mode", type: "string" },
    { name: "json", type: "boolean" },
    { name: "explain", type: "boolean" },
    { name: "scope-first", type: "boolean" },
    { name: "no-scope-first", type: "boolean" },
  ]);
  const text = o._.join(" ").trim();
  if (!text) {
    throw new MemoryError(ErrorCodes.USAGE, "query 需要一个查询文本");
  }
  const schemaType = o.type as string | undefined;
  const excludeTypes = o["exclude-type"] as string[] | undefined;
  if (schemaType && excludeTypes?.length) {
    throw new MemoryError(ErrorCodes.USAGE, "--type 与 --exclude-type 不能同时指定");
  }
  const ctx = await loadContext(Boolean(o.json) || Boolean(o.explain));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const modeRaw = o.mode != null ? String(o.mode) : cfg.search.mode;
  if (!VALID_MODES.has(modeRaw)) {
    throw new MemoryError(ErrorCodes.USAGE, `--mode 必须是 conservative|balanced|tokenmax，收到: ${modeRaw}`);
  }
  const mode = modeRaw as SearchMode;
  let sourceId = o.source as string | undefined;
  if (sourceId) {
    assertSourceScope(ctx.auth, sourceId);
  } else if (!ctx.auth.allowedSources.includes("*") && ctx.auth.allowedSources.length === 1) {
    sourceId = ctx.auth.allowedSources[0];
  }
  const embedder =
    cfg.embedding.provider !== "off" ? createEmbeddingProvider(cfg.embedding) : null;
  let scopeFirst: boolean | undefined;
  if (o["no-scope-first"]) scopeFirst = false;
  else if (o["scope-first"]) scopeFirst = true;
  let intentLexicon: Record<string, string[]> | null = null;
  try {
    const pack = await loadPack(cfg.schema_pack);
    intentLexicon = pack.intent_lexicon ?? null;
  } catch {
    /* pack 缺失时用内置词表 */
  }
  const conn = await openPglite(ctx.repoRoot);
  try {
    const { hits: rawHits, explain } = await hybridQueryDetailed(conn.db, {
      brainId: ctx.brainId,
      query: text,
      limit: o.limit !== undefined ? parseInt(String(o.limit), 10) || 10 : 10,
      sourceId,
      schemaType,
      excludeSchemaTypes: excludeTypes?.length ? excludeTypes : undefined,
      excludeSidecars: Boolean(o["exclude-sidecars"]),
      mode,
      embedder,
      repoRoot: ctx.repoRoot,
      intentLexicon,
      explain: Boolean(o.explain),
      search: cfg.search,
      skipCache: Boolean(o.explain),
      scopeFirst,
    });
    const hits = ctx.auth.allowedSources.includes("*")
      ? rawHits
      : rawHits.filter((h) => {
          try {
            assertPathScope(ctx.auth, h.path);
            return true;
          } catch {
            return false;
          }
        });
    if (o.explain || o.json) {
      const payload: Record<string, unknown> = { query: text, mode, results: hits };
      if (explain) payload.explain = explain;
      console.log(JSON.stringify(payload));
    } else {
      hits.forEach((h, i) => {
        const display = h.path.replace(new RegExp(`^brains/${ctx.brainId}/`), "");
        console.log(`${i + 1}. ${h.score.toFixed(3)}  ${display}`);
        console.log(`   ${h.title}`);
        console.log(`   ${h.snippet}`);
        if (h.evidence.length) console.log(`   [${h.evidence.join(",")}]`);
        console.log("");
      });
    }
    return 0;
  } finally {
    await conn.close();
  }
}

/** P5.5：与 query 同库同 mode，flags 透传。 */
export async function findCommand(argv: string[]): Promise<number> {
  try {
    return await queryCommand(argv);
  } catch (e) {
    if (e instanceof MemoryError && e.message === "query 需要一个查询文本") {
      throw new MemoryError(ErrorCodes.USAGE, "find 需要一个查询文本");
    }
    throw e;
  }
}
