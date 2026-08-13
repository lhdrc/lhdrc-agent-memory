import { MemoryError, ErrorCodes, findRepoRoot, loadRepoConfig, flushRepoLedger } from "@df-memory/core";
import { initCommand } from "./commands/init.ts";
import { entityCommand } from "./commands/entity.ts";
import { captureCommand } from "./commands/capture.ts";
import { importCommand } from "./commands/import.ts";
import { readCommand } from "./commands/read.ts";
import { treeCommand } from "./commands/tree.ts";
import { forgetCommand } from "./commands/forget.ts";
import { schemaCommand } from "./commands/schema.ts";
import { findCommand, queryCommand } from "./commands/query.ts";
import { thinkCommand } from "./commands/think.ts";
import { evalCommand } from "./commands/eval.ts";
import { agentCommand } from "./commands/agent.ts";
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
import { eventsCommand } from "./commands/events.ts";
import { ingestCommand } from "./commands/ingest.ts";
import { rememberCommand } from "./commands/remember.ts";
import { inboxCommand } from "./commands/inbox.ts";

const HELP = `df-memory CLI

用法:
  memory [--brain <id>] [--token <tok>] [--agent <id>] <cmd> ...
  memory init [dir] [--brain <id>] [--source <id>] [--force]
  memory brain <create|list>
  memory capture --title <t> --type <schema_type> --body <b> [--extract] [--no-dedupe] [options]
  memory import <file|dir> [--source <id>]
  memory ingest --list-adapters
  memory ingest --adapter generic-jsonl|df-app|session --input <file> [--json] [--continue-on-error] [--dry-run] [--retry <id>]
  memory remember --body "…" [--dry-run] [--json] [--extract|--no-extract]
  memory inbox list [--json] [--status pending|failed|done]
  memory query <text> [--limit N] [--source <id>] [--type <schema_type>] [--mode conservative|balanced|tokenmax] [--explain] [--json]
  memory find <text> [--limit N] [--source <id>] [--type <schema_type>] [--mode conservative|balanced|tokenmax] [--explain] [--json]
  memory think <text> [--json]
  memory eval --mini|--distill|--report|--adapter <id> [--fixture] [--json]
  memory eval fetch --adapter <id> --allow-net
  memory graph-query <text> [--limit N] [--source <id>] [--json]
  memory read <path> [--layer l0|l1|l2] [--json]
  memory layers refresh [--path <rel>] [--dirs] [--json]
  memory tree [path] [--depth N]
  memory forget <path> [--by <id>] [--purge --confirm]
  memory events <list|append>
  memory entity <create|list|resolve|merge|link-facts>
  memory agent <register|list>
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
  --agent 只能读写已登记 source（与 token 求交）；无 --agent 时 trusted local 行为不变。
  query --mode tokenmax：启发式扩写（llm=off 可演示）；--explain 含 queries/rerank/hotness/entity_boosts。
  forget --purge：物理删除，必须 --confirm；不可默认、不可自动化；需 owner。
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
  events: eventsCommand,
  ingest: ingestCommand,
  remember: rememberCommand,
  inbox: inboxCommand,
  find: findCommand,
  think: thinkCommand,
  eval: evalCommand,
  agent: agentCommand,
};

/** 剥离全局 --brain / --token / --agent，写入环境变量供 loadContext 使用。 */
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
    if (a === "--agent" || a.startsWith("--agent=")) {
      const v = a.startsWith("--agent=") ? a.slice("--agent=".length) : argv[++i];
      if (!v) throw new MemoryError(ErrorCodes.USAGE, "--agent 需要值");
      process.env.DF_MEMORY_AGENT = v;
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
