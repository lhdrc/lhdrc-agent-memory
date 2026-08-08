import {
  MemoryError,
  ErrorCodes,
  openPglite,
  graphArm,
  parseRelationalQuery,
} from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function graphQueryCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "limit", type: "string" },
    { name: "source", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const text = o._.join(" ").trim();
  if (!text) {
    throw new MemoryError(ErrorCodes.USAGE, "graph-query 需要一个查询文本");
  }
  const ctx = await loadContext(Boolean(o.json));
  const parsed = parseRelationalQuery(text);
  const conn = await openPglite(ctx.repoRoot);
  try {
    const hits = await graphArm(conn.db, {
      brainId: ctx.brainId,
      query: text,
      limit: o.limit !== undefined ? parseInt(String(o.limit), 10) || 20 : 20,
      sourceId: o.source as string | undefined,
    });
    if (o.json) {
      console.log(JSON.stringify({ query: text, parsed, results: hits }));
    } else {
      if (!parsed) {
        console.log("（未能解析为关系查询；返回空结果，fail-open）");
      } else {
        console.log(`seed=${parsed.seed}${parsed.verb ? ` verb=${parsed.verb}` : ""}`);
      }
      hits.forEach((h, i) => {
        const display = h.path.replace(new RegExp(`^brains/${ctx.brainId}/`), "");
        console.log(`${i + 1}. ${display}`);
        if (h.title) console.log(`   ${h.title}`);
        if (h.snippet) console.log(`   ${h.snippet}`);
        console.log("");
      });
    }
    return 0;
  } finally {
    await conn.close();
  }
}
