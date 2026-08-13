import { MemoryError, ErrorCodes, readNode, parseMemoryLayer, assertPathScope } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function readCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "json", type: "boolean" },
    { name: "layer", type: "string" },
  ]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "read 需要一个路径");
  }
  const layer = o.layer != null ? parseMemoryLayer(o.layer) : "l2";
  const ctx = await loadContext(Boolean(o.json));
  const scoped = path.startsWith("brains/") ? path : `brains/${ctx.brainId}/${path}`;
  assertPathScope(ctx.auth, scoped);
  const { rel, raw, content, chars } = await readNode(ctx.repoRoot, ctx.brainId, path, { layer });
  assertPathScope(ctx.auth, rel);
  if (o.json) {
    console.log(JSON.stringify({ path: rel, layer, content, chars }));
  } else if (layer === "l2") {
    process.stdout.write(raw + "\n");
  } else {
    process.stdout.write(content + (content.endsWith("\n") ? "" : "\n"));
  }
  return 0;
}
