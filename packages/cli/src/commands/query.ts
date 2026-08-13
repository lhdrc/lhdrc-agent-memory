import {
  MemoryError,
  ErrorCodes,
  openPglite,
  hybridQueryDetailed,
  createEmbeddingProvider,
  loadRepoConfig,
  loadPack,
  recordQueryStat,
  type SearchMode,
} from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

const VALID_MODES = new Set<string>(["conservative", "balanced", "tokenmax"]);

export async function queryCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "limit", type: "string" },
    { name: "source", type: "string" },
    { name: "type", type: "string" },
    { name: "mode", type: "string" },
    { name: "json", type: "boolean" },
    { name: "explain", type: "boolean" },
  ]);
  const text = o._.join(" ").trim();
  if (!text) {
    throw new MemoryError(ErrorCodes.USAGE, "query 需要一个查询文本");
  }
  const ctx = await loadContext(Boolean(o.json) || Boolean(o.explain));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const modeRaw = o.mode != null ? String(o.mode) : cfg.search.mode;
  if (!VALID_MODES.has(modeRaw)) {
    throw new MemoryError(ErrorCodes.USAGE, `--mode 必须是 conservative|balanced|tokenmax，收到: ${modeRaw}`);
  }
  const mode = modeRaw as SearchMode;
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
    const { hits, explain } = await hybridQueryDetailed(conn.db, {
      brainId: ctx.brainId,
      query: text,
      limit: o.limit !== undefined ? parseInt(String(o.limit), 10) || 10 : 10,
      sourceId: o.source as string | undefined,
      schemaType: o.type as string | undefined,
      mode,
      embedder,
      repoRoot: ctx.repoRoot,
      intentLexicon,
      explain: Boolean(o.explain),
      search: cfg.search,
      skipCache: Boolean(o.explain),
    });
    const avgScore = hits.length ? hits.reduce((s, h) => s + h.score, 0) / hits.length : 0;
    await recordQueryStat(ctx.repoRoot, {
      query: text,
      hitCount: hits.length,
      avgScore,
    }).catch(() => {});
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
