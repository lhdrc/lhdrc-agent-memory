import { loadRepoConfig, WriteQueue, pgliteIndexHooks, runDream, type DreamPhase } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

export async function dreamCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "fix", type: "boolean" },
    { name: "phases", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = new WriteQueue(ctx.repoRoot, cfg, pgliteIndexHooks);

  let phases: DreamPhase[] | undefined;
  if (o.phases) {
    phases = String(o.phases)
      .split(",")
      .map((s) => parseInt(s.trim(), 10) as DreamPhase)
      .filter((n) => n >= 1 && n <= 5);
  }

  const result = await runDream(ctx.repoRoot, {
    brainId: ctx.brainId,
    queue,
    fix: Boolean(o.fix),
    phases,
  });

  if (o.json) {
    console.log(JSON.stringify(result));
  } else {
    for (const p of result.phases) {
      const flag = p.skipped ? "skip" : p.ok ? "ok" : "fail";
      console.log(`[${p.phase}] ${p.name}: ${flag}${p.reason ? ` (${p.reason})` : ""}`);
      if (p.details) console.log(`    ${JSON.stringify(p.details)}`);
    }
  }
  return 0;
}
