import {
  MemoryError,
  ErrorCodes,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  revertMemoryDiff,
  revertUnsupportedMessage,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function revertCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [{ name: "json", type: "boolean" }]);
  const diffId = o._[0];
  if (!diffId) {
    throw new MemoryError(ErrorCodes.USAGE, "revert 需要 diffId 参数");
  }
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = new WriteQueue(ctx.repoRoot, cfg, pgliteIndexHooks);
  const result = await revertMemoryDiff(ctx.repoRoot, ctx.brainId, diffId, queue);

  if (!result.ok) {
    if (o.json) {
      console.log(JSON.stringify({ ok: false, reason: result.reason, op: result.op }));
      return 2;
    }
    if (result.reason === "not_found") {
      throw new MemoryError(ErrorCodes.NOT_FOUND, `无法回滚: not_found`);
    }
    throw new MemoryError(ErrorCodes.USAGE, revertUnsupportedMessage(result.op), {
      reason: result.reason,
      op: result.op,
    });
  }

  if (o.json) {
    console.log(JSON.stringify(result));
  } else if (result.reason === "already_noop") {
    console.log(`reverted ${diffId} (noop)`);
  } else {
    console.log(`reverted ${diffId} → ${result.path}`);
  }
  return 0;
}
