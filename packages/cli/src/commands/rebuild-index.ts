import { rebuildIndex } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function rebuildIndexCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "force", type: "boolean" },
    { name: "embeddings", type: "boolean" },
    { name: "pending-embeddings", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadContext(Boolean(o.json));
  const { fileCount, pendingEmbedded } = await rebuildIndex(ctx.repoRoot, ctx.brainId, {
    embeddings: Boolean(o.embeddings),
    pendingEmbeddings: Boolean(o["pending-embeddings"]),
  });
  if (o.json) {
    console.log(
      JSON.stringify({
        rebuilt: true,
        fileCount,
        embeddings: Boolean(o.embeddings),
        pendingEmbeddings: Boolean(o["pending-embeddings"]),
        pendingEmbedded: pendingEmbedded ?? 0,
      }),
    );
  } else {
    const bits: string[] = [];
    if (o.embeddings) bits.push("embeddings");
    if (o["pending-embeddings"]) bits.push(`pending ${pendingEmbedded ?? 0}`);
    const suffix = bits.length ? ` (${bits.join(", ")})` : "";
    console.log(`index rebuilt: ${fileCount} pages${suffix}`);
  }
  return 0;
}
