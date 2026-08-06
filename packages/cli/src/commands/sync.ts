import { loadRepoConfig, flushRepoLedger } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function syncCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "commit", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  if (!o.commit) {
    console.error("用法: memory sync --commit");
    return 2;
  }
  const ctx = await loadContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const result = await flushRepoLedger(ctx.repoRoot, cfg, "explicit", { throwOnError: true });
  if (o.json) {
    console.log(JSON.stringify({ committed: result.committed, fileCount: result.fileCount }));
  } else if (result.committed) {
    console.log(`committed ${result.fileCount} files`);
  } else {
    console.log("nothing to commit");
  }
  return 0;
}
