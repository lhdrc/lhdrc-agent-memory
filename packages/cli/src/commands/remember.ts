import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  MemoryError,
  ErrorCodes,
  loadPack,
  loadRepoConfig,
  compileSession,
  appendSessionTurns,
  acceptRememberJob,
  getJobRunner,
  assertRememberCompileReady,
  type CompileResult,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

function defaultCreatedBy(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
}

const HELP = `memory remember --body "…" | --body-file <path> | stdin
    [--wait] [--dry-run] [--json] [--extract | --no-extract] [--source <id>] [--buffer]

将会话原文编译为短记忆（须 LLM complete，或 --no-extract 当一条 note）。
默认异步入队，stdout 为 accepted + task_id；--wait 写完再返回 kept/path。
无 llm.provider/key 且未 --no-extract → 入队前 E_DISABLED（不写 L0，不入队）。

  --body / --body-file / stdin  原文（单条 user turn）
  --wait                        同步：写完再返回（验收/口令用）
  --dry-run                     不写 inbox、不写 sources；仍调 complete（同步）
  --extract                     默认：走编译器
  --no-extract                  跳过 complete，当一条 note
  --buffer                      追加到打开中的滑动窗口；达上限才 compile
  --json                        输出 kept / dropped / session_id 或缓冲状态
`;

export function formatCompileOutput(result: CompileResult, json: boolean, dryRun: boolean): void {
  if (json) {
    const body = {
      session_id: result.session_id ?? null,
      kept: result.kept,
      dropped: result.dropped,
      unresolved: result.unresolved,
      errors: result.errors,
      skipped_reason: result.skipped_reason,
      truncated: result.truncated,
      distill: result.distill,
      entities_created: result.entities_created,
    };
    console.log(JSON.stringify({ ok: result.errors.length === 0, result: body, ...body }));
    return;
  }
  for (const k of result.kept) {
    if (k.path) console.log(k.path);
    else console.log(`${k.type}\t${k.title}`);
  }
  if (result.session_id && !dryRun) console.log(`session_id=${result.session_id}`);
}

export function compileExitCode(result: CompileResult): number {
  return result.errors.length > 0 ? 2 : 0;
}

export async function rememberCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "body", type: "string" },
    { name: "body-file", type: "string" },
    { name: "source", type: "string" },
    { name: "dry-run", type: "boolean" },
    { name: "extract", type: "boolean" },
    { name: "no-extract", type: "boolean" },
    { name: "buffer", type: "boolean" },
    { name: "json", type: "boolean" },
    { name: "help", type: "boolean" },
    { name: "wait", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (o.extract && o["no-extract"]) {
    throw new MemoryError(ErrorCodes.USAGE, "不能同时 --extract 与 --no-extract");
  }
  if (o.buffer && o["dry-run"]) {
    throw new MemoryError(ErrorCodes.USAGE, "不能同时 --buffer 与 --dry-run");
  }
  if (o.buffer && o["no-extract"]) {
    throw new MemoryError(ErrorCodes.USAGE, "不能同时 --buffer 与 --no-extract");
  }

  let body: string | undefined;
  if (o.body !== undefined) body = String(o.body);
  else if (o["body-file"]) body = await readFile(resolve(String(o["body-file"])), "utf8");
  else if (!process.stdin.isTTY) body = await new Response(Bun.stdin).text();
  if (body === undefined || body.trim() === "") {
    throw new MemoryError(ErrorCodes.USAGE, "remember 需要 --body / --body-file / stdin");
  }

  const ctx = await loadContext(Boolean(o.json));
  const pack = await loadPack();
  const queue = await createQueue(ctx.repoRoot);
  const repoCfg = await loadRepoConfig(ctx.repoRoot);
  if (!o.buffer) {
    assertRememberCompileReady(repoCfg.llm, Boolean(o["no-extract"]));
  }

  if (o.buffer) {
    const appended = await appendSessionTurns({
      repoRoot: ctx.repoRoot,
      brainId: ctx.brainId,
      sourceId: (o.source as string) ?? ctx.sourceId,
      createdBy: defaultCreatedBy(),
      pack,
      queue,
      turns: [{ role: "user", text: body }],
      window: true,
    });
    if (o.json) {
      console.log(
        JSON.stringify({
          session_id: appended.session_id,
          buffered_turns: appended.buffered_turns,
          buffered_chars: appended.buffered_chars,
          compiled: appended.compiled ?? null,
        }),
      );
    } else {
      console.log(`session_id=${appended.session_id}`);
      if (appended.compiled) formatCompileOutput(appended.compiled, false, false);
    }
    return appended.compiled ? compileExitCode(appended.compiled) : 0;
  }

  if (o["dry-run"]) {
    const result = await compileSession({
      repoRoot: ctx.repoRoot,
      brainId: ctx.brainId,
      sourceId: (o.source as string) ?? ctx.sourceId,
      createdBy: defaultCreatedBy(),
      pack,
      queue,
      turns: [{ role: "user", text: body }],
      dryRun: true,
      noExtract: Boolean(o["no-extract"]),
    });
    formatCompileOutput(result, Boolean(o.json), true);
    return compileExitCode(result);
  }

  const job = await acceptRememberJob({
    repoRoot: ctx.repoRoot,
    brainId: ctx.brainId,
    sourceId: (o.source as string) ?? ctx.sourceId,
    createdBy: defaultCreatedBy(),
    queue,
    sessionId: "",
    turns: [{ role: "user", text: body }],
    noExtract: Boolean(o["no-extract"]),
  });

  if (!o.wait) {
    if (o.json) {
      const body = { accepted: true, task_id: job.task_id, status: "pending" };
      console.log(JSON.stringify({ ok: true, result: body, ...body }));
    } else {
      console.log(`accepted=true task_id=${job.task_id}`);
    }
    return 0;
  }

  const done = await getJobRunner(ctx.repoRoot, ctx.brainId).wait(job.task_id, job.timeoutMs);
  if (done.status === "failed") {
    throw new MemoryError(
      (done.error?.code as typeof ErrorCodes.JOB) ?? ErrorCodes.JOB,
      done.error?.message ?? "remember job failed",
    );
  }
  const output = (done.output ?? {}) as CompileResult & Record<string, unknown>;
  const result: CompileResult = {
    session_id: (output.session_id as string | undefined) ?? done.session_id,
    kept: (output.kept as CompileResult["kept"]) ?? [],
    dropped: (output.dropped as CompileResult["dropped"]) ?? [],
    unresolved: (output.unresolved as string[]) ?? [],
    errors: (output.errors as CompileResult["errors"]) ?? [],
    skipped_reason: output.skipped_reason as string | undefined,
    distill: output.distill as CompileResult["distill"],
    entities_created: output.entities_created as string[] | undefined,
  };
  if (o.json) {
    const body = {
      session_id: result.session_id ?? null,
      kept: result.kept,
      dropped: result.dropped,
      unresolved: result.unresolved,
      errors: result.errors,
      skipped_reason: result.skipped_reason,
      distill: result.distill,
      entities_created: result.entities_created,
      task_id: done.task_id,
      status: "done",
    };
    console.log(JSON.stringify({ ok: result.errors.length === 0, result: body, ...body }));
  } else {
    formatCompileOutput(result, false, false);
  }
  return compileExitCode(result);
}
