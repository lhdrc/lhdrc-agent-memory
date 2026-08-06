import { MemoryError, ErrorCodes, openPglite, bm25Query } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function queryCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "limit", type: "string" },
    { name: "source", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const text = o._.join(" ").trim();
  if (!text) {
    throw new MemoryError(ErrorCodes.USAGE, "query 需要一个查询文本");
  }
  const ctx = await loadContext(Boolean(o.json));
  const conn = await openPglite(ctx.repoRoot);
  try {
    const hits = await bm25Query(conn.db, {
      brainId: ctx.brainId,
      query: text,
      limit: o.limit !== undefined ? parseInt(String(o.limit), 10) || 10 : 10,
      sourceId: o.source as string | undefined,
    });
    if (o.json) {
      console.log(JSON.stringify({ query: text, results: hits }));
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
