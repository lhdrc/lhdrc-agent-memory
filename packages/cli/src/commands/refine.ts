import {
  MemoryError,
  ErrorCodes,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  refineSource,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function refineCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "path", type: "string" },
    { name: "source", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = new WriteQueue(ctx.repoRoot, cfg, pgliteIndexHooks);

  const result = await refineSource(ctx.repoRoot, {
    brainId: ctx.brainId,
    path: o.path as string | undefined,
    sourceId: o.source as string | undefined,
    queue,
  });

  if (result.skipped_reason) {
    const msg = `蒸馏已跳过（${result.skipped_reason}）: skipped=${result.skipped}`;
    if (o.json) {
      console.log(JSON.stringify({ ...result, message: msg }));
    } else {
      console.error(msg);
    }
    return 0;
  }

  if (o.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`refine: written=${result.written} skipped=${result.skipped}`);
    if (result.paths?.length) {
      for (const p of result.paths) console.log(`  ${p}`);
    }
  }
  return 0;
}
