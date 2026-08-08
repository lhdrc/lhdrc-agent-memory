import { MemoryError, ErrorCodes, readNode, assertPathScope } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function readCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [{ name: "json", type: "boolean" }]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "read 需要一个路径");
  }
  const ctx = await loadContext(Boolean(o.json));
  const scoped = path.startsWith("brains/") ? path : `brains/${ctx.brainId}/${path}`;
  assertPathScope(ctx.auth, scoped);
  const { rel, raw } = await readNode(ctx.repoRoot, ctx.brainId, path);
  assertPathScope(ctx.auth, rel);
  if (o.json) console.log(JSON.stringify({ path: rel, content: raw }));
  else process.stdout.write(raw + "\n");
  return 0;
}
