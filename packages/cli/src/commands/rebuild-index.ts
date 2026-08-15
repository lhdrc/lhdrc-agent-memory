import { rebuildIndex } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function rebuildIndexCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "force", type: "boolean" },
    { name: "embeddings", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadContext(Boolean(o.json));
  const { fileCount } = await rebuildIndex(ctx.repoRoot, ctx.brainId, {
    embeddings: Boolean(o.embeddings),
  });
  if (o.json) console.log(JSON.stringify({ rebuilt: true, fileCount, embeddings: Boolean(o.embeddings) }));
  else {
    const suffix = o.embeddings ? " (embeddings)" : "";
    console.log(`index rebuilt: ${fileCount} pages${suffix}`);
  }
  return 0;
}
