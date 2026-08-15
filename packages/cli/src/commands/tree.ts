import { MemoryError, ErrorCodes, listTree, renderTree, resolveNodeRelPath } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function treeCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "depth", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const input = o._[0] as string | undefined;
  const depth = o.depth !== undefined ? Math.max(1, parseInt(String(o.depth), 10) || 3) : 3;
  const ctx = await loadContext(Boolean(o.json));
  const relDir = input ? resolveNodeRelPath(ctx.repoRoot, ctx.brainId, input) : `brains/${ctx.brainId}`;
  const nodes = await listTree(ctx.repoRoot, ctx.brainId, relDir, depth);
  if (o.json) console.log(JSON.stringify(nodes));
  else console.log(renderTree(nodes).join("\n"));
  return 0;
}
