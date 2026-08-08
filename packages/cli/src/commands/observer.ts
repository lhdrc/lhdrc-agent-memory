import { collectObserverStats } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function observerCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [{ name: "json", type: "boolean" }]);
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const stats = await collectObserverStats(ctx.repoRoot, ctx.brainId);
  if (o.json) {
    console.log(JSON.stringify(stats));
  } else {
    console.log(`queries: ${stats.query_count}`);
    console.log(`zero-result rate: ${(stats.zero_result_rate * 100).toFixed(1)}%`);
    console.log(`avg score: ${stats.avg_score.toFixed(4)}`);
    console.log(`distill ops: ${stats.distill_count}`);
    console.log(
      `cost: entries=${stats.cost.entries} in=${stats.cost.tokens_in} out=${stats.cost.tokens_out} skipped=${stats.cost.skipped}`,
    );
  }
  return 0;
}
