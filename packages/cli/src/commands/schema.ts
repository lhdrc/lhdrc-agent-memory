import { MemoryError, ErrorCodes, loadRepoConfig, setSchemaPack } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

export async function schemaCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "use") {
    throw new MemoryError(ErrorCodes.USAGE, `未知 schema 子命令: ${sub ?? ""}（仅支持 use）`);
  }
  const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
  const packId = o._[0] as string | undefined;
  if (!packId) {
    throw new MemoryError(ErrorCodes.USAGE, "schema use 需要一个 packId");
  }
  if (packId !== "problem-tree") {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `schema pack 不可用: ${packId}（MVP 仅 problem-tree）`);
  }
  const ctx = await loadContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = await createQueue(ctx.repoRoot);
  const changed = await setSchemaPack(ctx.repoRoot, ctx.brainId, packId, queue);
  if (o.json) console.log(JSON.stringify({ pack: packId, changed }));
  else console.log(`schema pack -> ${packId}`);
  return 0;
}
