import { rebuildIndex } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function rebuildIndexCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "force", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadContext(Boolean(o.json));
  const { fileCount } = await rebuildIndex(ctx.repoRoot);
  if (o.json) console.log(JSON.stringify({ rebuilt: true, fileCount }));
  else console.log(`index rebuilt: ${fileCount} pages`);
  return 0;
}
