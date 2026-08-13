import { listInbox, MemoryError, ErrorCodes } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

const HELP = `memory inbox list [--json] [--status pending|failed|done]

列出 .dfmemory/inbox 会话（原文队列，不是 L0）。
retry 见 memory ingest --adapter session --retry <id>。
`;

export async function inboxCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return 0;
  }
  if (sub !== "list") {
    throw new MemoryError(ErrorCodes.USAGE, `未知 inbox 子命令: ${sub}（仅 list）`);
  }
  const o = parseArgs(rest, [
    { name: "json", type: "boolean" },
    { name: "status", type: "string" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const statusRaw = o.status as string | undefined;
  const status =
    statusRaw === "pending" || statusRaw === "failed" || statusRaw === "done" ? statusRaw : undefined;
  if (statusRaw && !status) {
    throw new MemoryError(ErrorCodes.USAGE, `--status 须为 pending|failed|done`);
  }
  const ctx = await loadContext(Boolean(o.json));
  const items = await listInbox(ctx.repoRoot, ctx.brainId, status);
  if (o.json) {
    console.log(JSON.stringify({ sessions: items }));
  } else {
    for (const s of items) {
      console.log(`${s.status}\t${s.session_id}`);
    }
  }
  return 0;
}
