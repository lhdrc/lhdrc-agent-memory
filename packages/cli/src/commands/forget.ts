import { MemoryError, ErrorCodes, forgetNode, resolveNodeRelPath } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

export async function forgetCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "by", type: "string" },
    { name: "purge", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "forget 需要一个路径");
  }
  if (o.purge) {
    throw new MemoryError(ErrorCodes.USAGE, "--purge 未实现（接口预留）");
  }
  const ctx = await loadContext(Boolean(o.json));
  const rel = resolveNodeRelPath(ctx.repoRoot, ctx.brainId, path);
  const queue = await createQueue(ctx.repoRoot);
  await forgetNode(ctx.repoRoot, rel, queue, (o.by as string) ?? "cli:user");
  if (o.json) console.log(JSON.stringify({ path: rel, status: "archived" }));
  else console.log(`archived ${rel}`);
  return 0;
}
