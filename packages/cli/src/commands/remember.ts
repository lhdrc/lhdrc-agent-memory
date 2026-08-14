import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  MemoryError,
  ErrorCodes,
  loadPack,
  compileSession,
  type CompileResult,
} from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

function defaultCreatedBy(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
}

const HELP = `memory remember --body "…" | --body-file <path> | stdin
    [--dry-run] [--json] [--extract | --no-extract] [--source <id>]

将会话原文编译为短记忆（须 LLM complete，或 --no-extract 当一条 note）。
无 llm.provider/key 且未 --no-extract → E_DISABLED。

  --body / --body-file / stdin  原文（单条 user turn）
  --dry-run                     不写 inbox、不写 sources；仍调 complete
  --extract                     默认：走编译器
  --no-extract                  跳过 complete，当一条 note
  --json                        输出 kept / dropped / session_id
`;

export function formatCompileOutput(result: CompileResult, json: boolean, dryRun: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({
        session_id: result.session_id ?? null,
        kept: result.kept,
        dropped: result.dropped,
        unresolved: result.unresolved,
        errors: result.errors,
        skipped_reason: result.skipped_reason,
        truncated: result.truncated,
        distill: result.distill,
      }),
    );
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
    { name: "json", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (o.extract && o["no-extract"]) {
    throw new MemoryError(ErrorCodes.USAGE, "不能同时 --extract 与 --no-extract");
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
  const result = await compileSession({
    repoRoot: ctx.repoRoot,
    brainId: ctx.brainId,
    sourceId: (o.source as string) ?? ctx.sourceId,
    createdBy: defaultCreatedBy(),
    pack,
    queue,
    turns: [{ role: "user", text: body }],
    dryRun: Boolean(o["dry-run"]),
    noExtract: Boolean(o["no-extract"]),
  });
  formatCompileOutput(result, Boolean(o.json), Boolean(o["dry-run"]));
  return compileExitCode(result);
}
