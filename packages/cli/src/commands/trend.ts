import { queryTrend, MemoryError, ErrorCodes } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function trendCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "json", type: "boolean" },
    { name: "threshold", type: "string" },
  ]);
  const metric = o._[0];
  if (!metric) {
    throw new MemoryError(ErrorCodes.USAGE, "memory trend 需要 metric 参数");
  }
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const thresholdRaw = o.threshold;
  const threshold = thresholdRaw != null ? Number(thresholdRaw) : undefined;
  const result = await queryTrend(
    ctx.repoRoot,
    ctx.brainId,
    { metric, threshold },
    ctx.cfg.trend,
  );
  if (o.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`metric: ${result.metric}`);
    console.log(`points: ${result.points.length}`);
    for (const p of result.points) {
      console.log(`  ${p.at}  ${p.value}  ${p.path}`);
    }
    console.log(`drop: ${result.drop.toFixed(4)}  threshold: ${result.threshold}`);
    console.log(`regressing: ${result.regressing}${result.reason ? ` (${result.reason})` : ""}`);
  }
  return 0;
}
