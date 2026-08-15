/**
 * P7.3 滑动窗口：攒 turns，达上限或 endSession 再 compileSession。
 */
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadRepoConfig } from "../repo/config.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import {
  appendTurnsToSession,
  archiveSession,
  countUserAssistant,
  loadSession,
  type Turn,
} from "../inbox/session.ts";
import { readOpenSessionId, writeOpenSessionId } from "../inbox/open.ts";
import { compileSession, type CompileResult, type CompileSessionOpts } from "./session.ts";

export type AppendSessionTurnsOpts = {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  createdBy: string;
  pack: SchemaPack;
  queue: FileMutationExecutor;
  turns: Turn[];
  sessionId?: string;
  window: true;
  llm?: CompileSessionOpts["llm"];
  /** P8.1：达窗只返回 shouldCompile，不调 complete()。缺省 false，CLI --buffer 不变。 */
  deferCompile?: boolean;
  /** P8.1 挂钩：false 时不读不写 `.open`，必须带 sessionId。缺省 true。 */
  bindOpen?: boolean;
};

export type AppendResult = {
  session_id: string;
  buffered_turns: number;
  buffered_chars: number;
  compiled?: CompileResult;
  /** P8.1：deferCompile 且达窗时为 true */
  shouldCompile?: boolean;
};

export type EndSessionOpts = {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  createdBy: string;
  pack: SchemaPack;
  queue: FileMutationExecutor;
  sessionId?: string;
  llm?: CompileSessionOpts["llm"];
};

function assertWindowEnabled(maxTurns: number): void {
  if (maxTurns <= 0) {
    throw new MemoryError(ErrorCodes.USAGE, "compile.window_max_turns≤0：未开启滑动窗口（不要用 --buffer / --window）");
  }
}

export async function appendSessionTurns(opts: AppendSessionTurnsOpts): Promise<AppendResult> {
  const cfg = await loadRepoConfig(opts.repoRoot);
  assertWindowEnabled(cfg.compile.window_max_turns);
  const maxTurns = cfg.compile.window_max_turns;
  const maxChars = cfg.compile.window_max_chars;

  const bindOpen = opts.bindOpen !== false;
  let sessionId = opts.sessionId?.trim() || (bindOpen ? await readOpenSessionId(opts.repoRoot, opts.brainId) : "");
  if (!bindOpen && !sessionId) {
    throw new MemoryError(ErrorCodes.USAGE, "appendSessionTurns(bindOpen:false) 需要 sessionId");
  }
  if (!sessionId) {
    const created = await archiveSession({
      repoRoot: opts.repoRoot,
      brainId: opts.brainId,
      sourceId: opts.sourceId,
      createdBy: opts.createdBy,
      turns: [],
      toolMaxChars: cfg.compile.tool_max_chars,
    });
    sessionId = created.sessionId;
    if (bindOpen) await writeOpenSessionId(opts.repoRoot, opts.brainId, sessionId);
  } else {
    let loaded: Awaited<ReturnType<typeof loadSession>> | null = null;
    try {
      loaded = await loadSession(opts.repoRoot, opts.brainId, sessionId);
    } catch (e) {
      if (!(e instanceof MemoryError) || e.code !== ErrorCodes.NOT_FOUND) throw e;
    }
    if (!loaded) {
      await archiveSession({
        repoRoot: opts.repoRoot,
        brainId: opts.brainId,
        sourceId: opts.sourceId,
        createdBy: opts.createdBy,
        turns: [],
        sessionId,
        toolMaxChars: cfg.compile.tool_max_chars,
      });
    } else {
      if (loaded.meta.status === "done") {
        throw new MemoryError(ErrorCodes.CONFLICT, `inbox session 已结束: ${sessionId}`);
      }
      if (loaded.meta.status === "failed") {
        throw new MemoryError(ErrorCodes.CONFLICT, `inbox session 已失败: ${sessionId}`);
      }
    }
    if (bindOpen) {
      const openId = await readOpenSessionId(opts.repoRoot, opts.brainId);
      if (openId !== sessionId) await writeOpenSessionId(opts.repoRoot, opts.brainId, sessionId);
    }
  }

  const allTurns = await appendTurnsToSession({
    repoRoot: opts.repoRoot,
    brainId: opts.brainId,
    sessionId,
    turns: opts.turns,
    toolMaxChars: cfg.compile.tool_max_chars,
  });
  const buf = countUserAssistant(allTurns);
  const over = buf.turns >= maxTurns || (maxChars > 0 && buf.chars >= maxChars);
  if (!over) {
    return { session_id: sessionId, buffered_turns: buf.turns, buffered_chars: buf.chars };
  }

  if (opts.deferCompile) {
    return {
      session_id: sessionId,
      buffered_turns: buf.turns,
      buffered_chars: buf.chars,
      shouldCompile: true,
    };
  }

  const compiled = await compileSession({
    repoRoot: opts.repoRoot,
    brainId: opts.brainId,
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    pack: opts.pack,
    queue: opts.queue,
    sessionId,
    llm: opts.llm,
  });
  return { session_id: sessionId, buffered_turns: buf.turns, buffered_chars: buf.chars, compiled };
}

export async function endSession(opts: EndSessionOpts): Promise<CompileResult> {
  const sessionId = opts.sessionId?.trim() || (await readOpenSessionId(opts.repoRoot, opts.brainId));
  if (!sessionId) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, "没有打开中的滑动窗口（无 .open / --session）");
  }
  await loadSession(opts.repoRoot, opts.brainId, sessionId);
  return compileSession({
    repoRoot: opts.repoRoot,
    brainId: opts.brainId,
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    pack: opts.pack,
    queue: opts.queue,
    sessionId,
    llm: opts.llm,
  });
}
