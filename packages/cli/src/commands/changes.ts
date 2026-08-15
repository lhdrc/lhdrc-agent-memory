import { listMemoryDiffs } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function changesCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "limit", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const limit = o.limit !== undefined ? parseInt(String(o.limit), 10) || 20 : 20;
  const entries = await listMemoryDiffs(ctx.repoRoot, ctx.brainId, limit);

  if (o.json) {
    console.log(JSON.stringify({ entries }));
  } else {
    for (const e of entries) {
      console.log(`${e.at}  ${e.id}  ${e.op}`);
      if (e.paths_written.length) console.log(`  written: ${e.paths_written.join(", ")}`);
    }
    if (entries.length === 0) console.log("(no changes)");
  }
  return 0;
}
