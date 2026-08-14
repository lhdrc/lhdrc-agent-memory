import { resolve } from "node:path";
import { initMemoryRepo, type GitInitPolicy } from "@df-memory/core";
import { parseArgs } from "../args.ts";

function parseGitInitPolicy(raw: string | undefined): GitInitPolicy | undefined {
  if (raw === "init" || raw === "existing" || raw === "off") return raw;
  return undefined;
}

export async function initCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "brain", type: "string" },
    { name: "source", type: "string" },
    { name: "force", type: "boolean" },
    { name: "git", type: "string" },
  ]);
  const dir = (o._[0] as string) ?? ".";
  const gitRaw = o.git as string | undefined;
  const git = parseGitInitPolicy(gitRaw);
  if (gitRaw !== undefined && git === undefined) {
    console.error(`invalid --git value: ${gitRaw} (expected init|existing|off)`);
    return 1;
  }
  const abs = await initMemoryRepo(dir, {
    brain: (o.brain as string) ?? "default",
    source: (o.source as string) ?? "default",
    force: Boolean(o.force),
    git,
  });
  console.log(`initialized memory repo at ${resolve(abs)}`);
  return 0;
}
