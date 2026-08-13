import { MemoryError, ErrorCodes, forgetNode, purgeNode, assertCanPurge, resolveNodeRelPath } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

export async function forgetCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "by", type: "string" },
    { name: "purge", type: "boolean" },
    { name: "confirm", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "forget 需要一个路径");
  }
  const ctx = await loadContext(Boolean(o.json));
  const rel = resolveNodeRelPath(ctx.repoRoot, ctx.brainId, path);
  const queue = await createQueue(ctx.repoRoot);
  const by = (o.by as string) ?? "cli:user";

  if (o.purge) {
    if (!o.confirm) {
      throw new MemoryError(ErrorCodes.USAGE, "forget --purge 需要 --confirm（硬删不可默认、不可自动化）");
    }
    assertCanPurge(ctx.auth);
    await purgeNode(ctx.repoRoot, rel, queue, by);
    if (o.json) console.log(JSON.stringify({ path: rel, status: "purged" }));
    else console.log(`purged ${rel}`);
    return 0;
  }

  await forgetNode(ctx.repoRoot, rel, queue, by);
  if (o.json) console.log(JSON.stringify({ path: rel, status: "archived" }));
  else console.log(`archived ${rel}`);
  return 0;
}
