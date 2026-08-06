import { MemoryError, ErrorCodes, readNode } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function readCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [{ name: "json", type: "boolean" }]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "read 需要一个路径");
  }
  const ctx = await loadContext(Boolean(o.json));
  const { rel, raw } = await readNode(ctx.repoRoot, ctx.brainId, path);
  if (o.json) console.log(JSON.stringify({ path: rel, content: raw }));
  else process.stdout.write(raw + "\n");
  return 0;
}
