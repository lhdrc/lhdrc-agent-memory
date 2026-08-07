import {
  MemoryError,
  ErrorCodes,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  refineSource,
} from "@df-memory/core";
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

  if (result.reason === "llm_off") {
    const msg = `蒸馏已跳过（llm.provider=off 或 kill_switch.distill=true）: skipped=${result.skipped}`;
    if (o.json) {
      console.log(JSON.stringify({ ...result, message: msg }));
    } else {
      console.log(msg);
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
