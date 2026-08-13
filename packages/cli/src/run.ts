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
import { graphQueryCommand } from "./commands/graph-query.ts";
import { rebuildIndexCommand } from "./commands/rebuild-index.ts";
import { syncCommand } from "./commands/sync.ts";
import { refineCommand } from "./commands/refine.ts";
import { changesCommand } from "./commands/changes.ts";
import { revertCommand } from "./commands/revert.ts";
import { skillCommand } from "./commands/skill.ts";
import { dreamCommand } from "./commands/dream.ts";
import { observerCommand } from "./commands/observer.ts";
import { brainCommand } from "./commands/brain.ts";
import { layersCommand } from "./commands/layers.ts";

const HELP = `df-memory CLI

用法:
  memory [--brain <id>] [--token <tok>] <cmd> ...
  memory init [dir] [--brain <id>] [--source <id>] [--force]
  memory brain <create|list>
  memory capture --title <t> --type <schema_type> --body <b> [--extract] [--no-dedupe] [options]
  memory import <file|dir> [--source <id>]
  memory query <text> [--limit N] [--source <id>] [--type <schema_type>] [--mode <m>] [--explain] [--json]
  memory graph-query <text> [--limit N] [--source <id>] [--json]
  memory read <path> [--layer l0|l1|l2] [--json]
  memory layers refresh [--path <rel>] [--dirs] [--json]
  memory tree [path] [--depth N]
  memory forget <path> [--by <id>]
  memory entity <create|list|resolve|merge>
  memory rebuild-index
  memory schema use <packId>
  memory sync --commit
  memory refine [--path <rel>] [--json]
  memory changes [--limit N]
  memory revert <diffId>
  memory skill <crystallize|activate|outcome|list|experience-outcome>
  memory dream [--fix] [--phases 1,2,3]
  memory observer [--json]

说明:
  单仓多 brain 时 git 历史对同仓可见，非密码学隔离。
  本地 CLI 无 token 视为 trusted local（owner）；远程面无 token → E_AUTH。
`;

type Command = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  brain: brainCommand,
  entity: entityCommand,
  capture: captureCommand,
  import: importCommand,
  read: readCommand,
  tree: treeCommand,
  forget: forgetCommand,
  schema: schemaCommand,
  query: queryCommand,
  "graph-query": graphQueryCommand,
  "rebuild-index": rebuildIndexCommand,
  sync: syncCommand,
  refine: refineCommand,
  changes: changesCommand,
  revert: revertCommand,
  skill: skillCommand,
  dream: dreamCommand,
  observer: observerCommand,
  layers: layersCommand,
};

/** 剥离全局 --brain / --token，写入环境变量供 loadContext 使用。 */
export function peelGlobalFlags(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--brain" || a.startsWith("--brain=")) {
      const v = a.startsWith("--brain=") ? a.slice("--brain=".length) : argv[++i];
      if (!v) throw new MemoryError(ErrorCodes.USAGE, "--brain 需要值");
      process.env.DF_MEMORY_BRAIN = v;
      continue;
    }
    if (a === "--token" || a.startsWith("--token=")) {
      const v = a.startsWith("--token=") ? a.slice("--token=".length) : argv[++i];
      if (!v) throw new MemoryError(ErrorCodes.USAGE, "--token 需要值");
      process.env.DF_MEMORY_TOKEN = v;
      continue;
    }
    rest.push(a);
  }
  return rest;
}

export async function run(argv: string[]): Promise<number> {
  const peeled = peelGlobalFlags(argv);
  const [cmd, ...rest] = peeled;
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
