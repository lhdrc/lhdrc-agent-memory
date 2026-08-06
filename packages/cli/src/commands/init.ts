import { resolve } from "node:path";
import { initMemoryRepo } from "@df-memory/core";
import { parseArgs } from "../args.ts";

export async function initCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "brain", type: "string" },
    { name: "source", type: "string" },
    { name: "force", type: "boolean" },
  ]);
  const dir = (o._[0] as string) ?? ".";
  const abs = await initMemoryRepo(dir, {
    brain: (o.brain as string) ?? "default",
    source: (o.source as string) ?? "default",
    force: Boolean(o.force),
  });
  console.log(`initialized memory repo at ${resolve(abs)}`);
  return 0;
}
