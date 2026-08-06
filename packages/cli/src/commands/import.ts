import { MemoryError, ErrorCodes, loadPack, importPath } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

export async function importCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "source", type: "string" },
    { name: "created-by", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  const input = o._[0] as string | undefined;
  if (!input) {
    throw new MemoryError(ErrorCodes.USAGE, "import 需要一个文件或目录");
  }
  const ctx = await loadContext(Boolean(o.json));
  const createdBy = (o["created-by"] as string) ?? `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
  const pack = await loadPack();
  const queue = await createQueue(ctx.repoRoot);
  const results = await importPath(ctx.repoRoot, pack, queue, input, {
    brainId: ctx.brainId,
    sourceId: (o.source as string) ?? ctx.sourceId,
    createdBy,
  });
  if (o.json) {
    console.log(JSON.stringify(results.map((r) => ({ from: r.sourcePath, path: r.destRel }))));
  } else {
    for (const r of results) console.log(r.destRel);
  }
  return 0;
}
