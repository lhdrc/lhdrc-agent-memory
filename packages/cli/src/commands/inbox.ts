import { listInbox, MemoryError, ErrorCodes, loadPack, endSession, retrySession } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";
import { compileExitCode, formatCompileOutput } from "./remember.ts";

const HELP = `memory inbox list [--json] [--status pending|failed|done]
memory inbox retry <sessionId> [--json] [--dry-run]
memory inbox end [--session <id>] [--json]

列出 .dfmemory/inbox 会话（原文队列，不是 L0）。
retry：与 ingest --adapter session --retry 同一实现。
end：compile 打开中的滑动窗口。
`;

export async function inboxCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return 0;
  }
  if (sub !== "list" && sub !== "end" && sub !== "retry") {
    throw new MemoryError(ErrorCodes.USAGE, `未知 inbox 子命令: ${sub}（list|retry|end）`);
  }
  const o = parseArgs(rest, [
    { name: "json", type: "boolean" },
    { name: "status", type: "string" },
    { name: "session", type: "string" },
    { name: "dry-run", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (sub === "retry") {
    const sessionId = String(o._[0] ?? "").trim();
    if (!sessionId) {
      throw new MemoryError(ErrorCodes.USAGE, "inbox retry 需要 sessionId");
    }
    const ctx = await loadContext(Boolean(o.json));
    const pack = await loadPack();
    const queue = await createQueue(ctx.repoRoot);
    const result = await retrySession({
      repoRoot: ctx.repoRoot,
      brainId: ctx.brainId,
      sourceId: ctx.sourceId,
      createdBy: `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`,
      pack,
      queue,
      sessionId,
      dryRun: Boolean(o["dry-run"]),
    });
    formatCompileOutput(result, Boolean(o.json), Boolean(o["dry-run"]));
    return compileExitCode(result);
  }
  if (sub === "end") {
    const ctx = await loadContext(Boolean(o.json));
    const pack = await loadPack();
    const queue = await createQueue(ctx.repoRoot);
    const result = await endSession({
      repoRoot: ctx.repoRoot,
      brainId: ctx.brainId,
      sourceId: ctx.sourceId,
      createdBy: `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`,
      pack,
      queue,
      sessionId: o.session as string | undefined,
    });
    formatCompileOutput(result, Boolean(o.json), false);
    return compileExitCode(result);
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
