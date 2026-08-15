import {
  MemoryError,
  ErrorCodes,
  openPglite,
  graphArmDetailed,
  parseRelationalQuery,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

const EMPTY_HINT = "未识别为关系句，且查询词未命中实体邻接；可改用 memory query";

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
    const { hits, mode } = await graphArmDetailed(conn.db, {
      brainId: ctx.brainId,
      query: text,
      limit: o.limit !== undefined ? parseInt(String(o.limit), 10) || 20 : 20,
      sourceId: o.source as string | undefined,
    });
    if (o.json) {
      const payload: Record<string, unknown> = {
        query: text,
        parsed: parsed ?? null,
        mode,
        hits,
        results: hits,
      };
      if (mode === "empty") payload.hint = EMPTY_HINT;
      if (mode === "adjacency") payload.hint = "已按实体邻接检索";
      console.log(JSON.stringify(payload));
    } else {
      if (mode === "relational" && parsed) {
        console.log(`seed=${parsed.seed}${parsed.verb ? ` verb=${parsed.verb}` : ""}`);
      } else if (mode === "adjacency") {
        console.log("已按实体邻接检索");
      } else {
        console.log(EMPTY_HINT);
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
