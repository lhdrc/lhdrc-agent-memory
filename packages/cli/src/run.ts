import { MemoryError, ErrorCodes, findRepoRoot, loadRepoConfig, flushRepoLedger } from "@df-memory/core";
import { initCommand } from "./commands/init.ts";
import { entityCommand } from "./commands/entity.ts";
import { captureCommand } from "./commands/capture.ts";
import { importCommand } from "./commands/import.ts";
import { readCommand } from "./commands/read.ts";
import { treeCommand } from "./commands/tree.ts";
import { forgetCommand } from "./commands/forget.ts";
import { schemaCommand } from "./commands/schema.ts";
import { queryCommand } from "./commands/query.ts";
import { rebuildIndexCommand } from "./commands/rebuild-index.ts";
import { syncCommand } from "./commands/sync.ts";
import { refineCommand } from "./commands/refine.ts";
import { changesCommand } from "./commands/changes.ts";
import { revertCommand } from "./commands/revert.ts";

const HELP = `df-memory CLI MVP

用法:
  memory init [dir] [--brain <id>] [--source <id>] [--force]
  memory capture --title <t> --type <schema_type> --body <b> [options]
  memory import <file|dir> [--source <id>]
  memory query <text> [--limit N] [--source <id>] [--type <schema_type>] [--json]
  memory read <path>
  memory tree [path] [--depth N]
  memory forget <path> [--by <id>]
  memory entity <create|list|resolve|merge>
  memory rebuild-index
  memory schema use <packId>
  memory sync --commit
  memory refine [--path <rel>] [--json]
  memory changes [--limit N]
  memory revert <diffId>
`;

type Command = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  entity: entityCommand,
  capture: captureCommand,
  import: importCommand,
  read: readCommand,
  tree: treeCommand,
  forget: forgetCommand,
  schema: schemaCommand,
  query: queryCommand,
  "rebuild-index": rebuildIndexCommand,
  sync: syncCommand,
  refine: refineCommand,
  changes: changesCommand,
  revert: revertCommand,
};

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    throw new MemoryError(ErrorCodes.USAGE, `未知命令: ${cmd}`);
  }
  return fn(rest);
}

/** CLI 正常退出时 best-effort flush dirty（D18）。 */
export async function bestEffortExitFlush(): Promise<void> {
  try {
    const repoRoot = findRepoRoot();
    const cfg = await loadRepoConfig(repoRoot);
    await flushRepoLedger(repoRoot, cfg, "exit", { throwOnError: false });
  } catch {
    /* 不在仓内或 flush 失败：忽略 */
  }
}
