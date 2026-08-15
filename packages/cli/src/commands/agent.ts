import { MemoryError, ErrorCodes, registerAgent, listAgents } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";
import { createQueue } from "../services.ts";

const HELP = `memory agent register --id <id> --source <s> [--source <s2>]
memory agent list [--json]

登记文件：brains/{brainId}/agents/{id}.yml
--agent 只能读写已登记 source；与 token 求交。非密码学隔离。
`;

export async function agentCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP.trimEnd());
    return 0;
  }

  const ctx = await loadNoSourceContext(rest.includes("--json"));

  if (sub === "list") {
    const o = parseArgs(rest, [{ name: "json", type: "boolean" }]);
    const agents = await listAgents(ctx.repoRoot, ctx.brainId);
    if (o.json) console.log(JSON.stringify({ agents }));
    else {
      if (agents.length === 0) console.log("(no agents)");
      for (const a of agents) console.log(`${a.id}  sources=${a.sources.join(",")}`);
    }
    return 0;
  }

  if (sub === "register") {
    const o = parseArgs(rest, [
      { name: "id", type: "string" },
      { name: "source", type: "string[]" },
      { name: "json", type: "boolean" },
    ]);
    const id = o.id as string | undefined;
    const sources = (o.source as string[] | undefined) ?? [];
    if (!id || sources.length === 0) {
      throw new MemoryError(ErrorCodes.USAGE, "agent register 需要 --id 与至少一个 --source");
    }
    const queue = await createQueue(ctx.repoRoot);
    const rec = await registerAgent(ctx.repoRoot, ctx.brainId, { id, sources }, queue);
    if (o.json) console.log(JSON.stringify(rec));
    else console.log(`registered ${rec.id}  sources=${rec.sources.join(",")}`);
    return 0;
  }

  throw new MemoryError(ErrorCodes.USAGE, `未知 agent 子命令: ${sub}`);
}
