import { MemoryError, ErrorCodes, listContradictions, resolveContradiction } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";
import { createQueue } from "../services.ts";

const HELP = `memory contradiction list [--json]
memory contradiction resolve <pair_id> --keep a|b|both [--json]
`;

export async function contradictionCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return 0;
  }
  const ctx = await loadNoSourceContext(argv.includes("--json"));
  if (sub === "list") {
    const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
    const items = await listContradictions(ctx.repoRoot, ctx.brainId);
    if (o.json) console.log(JSON.stringify({ items }));
    else if (items.length === 0) console.log("(no contradictions)");
    else {
      for (const it of items) {
        console.log(`${it.pair_id}  ${it.status}  ${it.pathA}#${it.factIndexA} ↔ ${it.pathB}#${it.factIndexB}`);
      }
    }
    return 0;
  }
  if (sub === "resolve") {
    const o = parseArgs(rest, [
      { name: "keep", type: "string" },
      { name: "json", type: "boolean" },
    ]);
    const pairId = o._[0] as string | undefined;
    const keep = String(o.keep ?? "");
    if (!pairId || (keep !== "a" && keep !== "b" && keep !== "both")) {
      console.error(HELP);
      throw new MemoryError(ErrorCodes.USAGE, "contradiction resolve 需要 <pair_id> 与 --keep a|b|both");
    }
    const queue = await createQueue(ctx.repoRoot);
    const item = await resolveContradiction(ctx.repoRoot, ctx.brainId, queue, {
      pairId,
      keep,
      by: "cli:user",
    });
    if (o.json) console.log(JSON.stringify(item));
    else console.log(`resolved ${item.pair_id} keep=${item.status}`);
    return 0;
  }
  throw new MemoryError(ErrorCodes.USAGE, `未知 contradiction 子命令: ${sub}`);
}
