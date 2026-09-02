import { MemoryError, ErrorCodes, readNode, parseMemoryLayer, assertPathScope } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function readCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "json", type: "boolean" },
    { name: "layer", type: "string" },
    { name: "with-history", type: "boolean" },
  ]);
  const path = o._[0] as string | undefined;
  if (!path) {
    throw new MemoryError(ErrorCodes.USAGE, "read 需要一个路径");
  }
  const layer = o.layer != null ? parseMemoryLayer(o.layer) : "l2";
  const withHistory = Boolean(o["with-history"]);
  const ctx = await loadContext(Boolean(o.json));
  const scoped = path.startsWith("brains/") ? path : `brains/${ctx.brainId}/${path}`;
  assertPathScope(ctx.auth, scoped);
  const res: any = withHistory
    ? await readNode(ctx.repoRoot, ctx.brainId, path, { layer, withHistory: true })
    : await readNode(ctx.repoRoot, ctx.brainId, path, { layer, withHistory: false });
  assertPathScope(ctx.auth, res.rel);
  if (o.json) {
    const out: Record<string, unknown> = { path: res.rel, layer, content: res.content, chars: res.chars };
    if (res.provenance) out.provenance = res.provenance;
    if (withHistory) {
      if (res.history !== undefined) out.history = res.history;
      if (res.historyTurns) out.historyTurns = res.historyTurns;
      if (res.historyEntries) out.historyEntries = res.historyEntries;
    }
    console.log(JSON.stringify(out));
  } else if (withHistory && res.history) {
    // human readable: show raw then history separator
    if (layer === "l2") process.stdout.write(res.raw + "\n");
    else process.stdout.write(res.content + (res.content.endsWith("\n") ? "" : "\n"));
    process.stdout.write(`\n--- history ---\n${res.history}\n`);
  } else if (layer === "l2") {
    process.stdout.write(res.raw + "\n");
  } else {
    process.stdout.write(res.content + (res.content.endsWith("\n") ? "" : "\n"));
  }
  return 0;
}
