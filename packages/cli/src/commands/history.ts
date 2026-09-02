import { MemoryError, ErrorCodes, readHistoryTurns, findHistoryEntriesForSession } from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";

export async function historyCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`memory history read --session <id> [--turn N] [--json]
  --session  inbox session id
  --turn     1-based user+assistant turn index (可重复指定: --turn 1 --turn 2)，缺省返回全部
  --brain    指定 brain（全局 --brain 亦可）
示例:
  memory history read --session abc123 --turn 2
  memory history read --session abc123 --json
`);
    return 0;
  }
  if (sub !== "read") {
    throw new MemoryError(ErrorCodes.USAGE, `history 未知子命令: ${sub} (仅支持 read)`);
  }
  const o = parseArgs(rest, [
    { name: "json", type: "boolean" },
    { name: "session", type: "string" },
    { name: "turn", type: "string[]" },
  ]);
  const sessionId = typeof o.session === "string" ? o.session.trim() : "";
  if (!sessionId) throw new MemoryError(ErrorCodes.USAGE, "history read 需要 --session <id>");
  const turnRaw = (o.turn as string[] | undefined) ?? [];
  const turns = turnRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 1);
  const ctx = await loadContext(Boolean(o.json));
  // readHistoryTurns handles filtering to user+assistant 1-based
  let historyTurns: Array<{ turn_index: number; role: string; text: string; at?: string }>;
  try {
    const slice = await readHistoryTurns(ctx.repoRoot, ctx.brainId, sessionId, turns.length ? turns : undefined);
    historyTurns = slice.map((s) => ({ turn_index: s.turn_index, role: s.turn.role, text: s.turn.text, ...(s.turn.at ? { at: s.turn.at } : {}) }));
  } catch (e) {
    if (e instanceof MemoryError) throw e;
    throw new MemoryError(ErrorCodes.NOT_FOUND, `无法读取 session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // also include history_index entries for trace
  let entries: unknown[] = [];
  try {
    entries = await findHistoryEntriesForSession(ctx.repoRoot, ctx.brainId, sessionId);
  } catch {
    entries = [];
  }
  if (o.json) {
    console.log(JSON.stringify({ session_id: sessionId, turns: historyTurns, history: historyTurns.map((t) => t.text).join("\n\n"), entries }));
  } else {
    for (const t of historyTurns) {
      process.stdout.write(`# turn ${t.turn_index} (${t.role})\n${t.text}\n\n`);
    }
  }
  return 0;
}
