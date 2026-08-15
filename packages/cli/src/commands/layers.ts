import {
  MemoryError,
  ErrorCodes,
  loadRepoConfig,
  refreshLayers,
  WriteQueue,
  pgliteIndexHooks,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";

const HELP = `memory layers refresh [--path <rel>] [--dirs] [--json]

分层：L0 abstract / L1 overview / L2 全文。
目录摘要落盘：brains/{brainId}/…/{dir}/_overview.md
超长 overview sidecar：同目录 {stem}.overview.md
`;

export async function layersCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP.trimEnd());
    return 0;
  }
  if (sub !== "refresh") {
    throw new MemoryError(ErrorCodes.USAGE, `未知 layers 子命令: ${sub}（仅 refresh）`);
  }

  const o = parseArgs(rest, [
    { name: "path", type: "string" },
    { name: "dirs", type: "boolean" },
    { name: "json", type: "boolean" },
  ]);
  const ctx = await loadNoSourceContext(Boolean(o.json));
  const cfg = await loadRepoConfig(ctx.repoRoot);
  const queue = new WriteQueue(ctx.repoRoot, cfg, pgliteIndexHooks);
  const result = await refreshLayers({
    repoRoot: ctx.repoRoot,
    brainId: ctx.brainId,
    queue,
    path: o.path as string | undefined,
    dirs: Boolean(o.dirs),
  });

  if (o.json) {
    console.log(JSON.stringify({ updated: result.updated }));
  } else {
    for (const u of result.updated) {
      const flags = [u.abstract ? "abstract" : "", u.overview ? "overview" : ""].filter(Boolean);
      console.log(`${u.path}${flags.length ? `  (${flags.join(",")})` : ""}`);
    }
    if (result.updated.length === 0) console.log("(no updates)");
  }
  return 0;
}
