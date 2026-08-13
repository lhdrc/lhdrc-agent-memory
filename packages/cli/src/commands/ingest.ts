import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MemoryError,
  ErrorCodes,
  loadPack,
  ingestJsonl,
  compileSession,
  retrySession,
  type IngestAdapter,
} from "@df-memory/core";
import { genericJsonlAdapter } from "@df-memory/ingest-generic-jsonl";
import { dfAppAdapter } from "@df-memory/ingest-df-app";
import { parseSessionInput } from "@df-memory/ingest-session";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";
import { compileExitCode, formatCompileOutput } from "./remember.ts";

const ADAPTERS: Record<string, IngestAdapter> = {
  "generic-jsonl": genericJsonlAdapter,
  "df-app": dfAppAdapter,
};

const SESSION_ADAPTER = "session";

const HELP = `memory ingest --list-adapters
memory ingest --adapter <id> --input <file> [--json] [--continue-on-error] [--source <id>]
memory ingest --adapter session --input <file> [--dry-run] [--json] [--continue-on-error] [--retry <id>] [--source <id>]

批量摄取。generic-jsonl / df-app 逐行 captureNode。
session：整场 turns 一次 compileSession（不走逐行 map）。

  --adapter            generic-jsonl | df-app | session
  --input              JSONL 或 JSON 数组文件（session 时每行是 turn）
  --dry-run            仅 session：不写 inbox / sources
  --retry <sessionId>  仅 session：有 extracted.json 则只补写盘，否则重跑 Extractor
  --continue-on-error  跳过坏行/坏条，好行仍落盘；有错误时退出码 2
  --json               输出 paths / errors 或 compile 结果
  --list-adapters      列出已注册适配器

退出码：全成功 0；校验/非法行 2；整场 LLM 失败 1。
`;

export function listIngestAdapters(): string[] {
  return [...Object.keys(ADAPTERS), SESSION_ADAPTER];
}

function defaultCreatedBy(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
}

export async function ingestCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "adapter", type: "string" },
    { name: "input", type: "string" },
    { name: "source", type: "string" },
    { name: "continue-on-error", type: "boolean" },
    { name: "list-adapters", type: "boolean" },
    { name: "json", type: "boolean" },
    { name: "dry-run", type: "boolean" },
    { name: "retry", type: "string" },
    { name: "no-extract", type: "boolean" },
    { name: "help", type: "boolean" },
  ]);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (o["list-adapters"]) {
    const ids = listIngestAdapters();
    if (o.json) console.log(JSON.stringify({ adapters: ids }));
    else ids.forEach((id) => console.log(id));
    return 0;
  }
  const adapterId = o.adapter as string | undefined;
  const input = o.input as string | undefined;
  const retryId = o.retry as string | undefined;
  if (!adapterId) {
    throw new MemoryError(ErrorCodes.USAGE, "ingest 需要 --adapter（见 --help）");
  }

  if (adapterId === SESSION_ADAPTER) {
    if (o["no-extract"]) {
      throw new MemoryError(ErrorCodes.USAGE, "ingest --adapter session 不支持 --no-extract（仅 remember 可用）");
    }
    const ctx = await loadContext(Boolean(o.json));
    const pack = await loadPack();
    const queue = await createQueue(ctx.repoRoot);
    const sourceId = (o.source as string) ?? ctx.sourceId;
    const createdBy = defaultCreatedBy();
    const dryRun = Boolean(o["dry-run"]);

    if (retryId) {
      const result = await retrySession({
        repoRoot: ctx.repoRoot,
        brainId: ctx.brainId,
        sourceId,
        createdBy,
        pack,
        queue,
        sessionId: retryId,
        dryRun,
      });
      formatCompileOutput(result, Boolean(o.json), dryRun);
      return compileExitCode(result);
    }

    if (!input) {
      throw new MemoryError(ErrorCodes.USAGE, "ingest --adapter session 需要 --input（或 --retry）");
    }
    const text = await readFile(resolve(input), "utf8");
    const turns = parseSessionInput(text);
    const result = await compileSession({
      repoRoot: ctx.repoRoot,
      brainId: ctx.brainId,
      sourceId,
      createdBy,
      pack,
      queue,
      turns,
      dryRun,
    });
    formatCompileOutput(result, Boolean(o.json), dryRun);
    const code = compileExitCode(result);
    if (code === 2 && !o["continue-on-error"] && result.kept.length === 0) return 2;
    return code;
  }

  if (!input) {
    throw new MemoryError(ErrorCodes.USAGE, "ingest 需要 --adapter 与 --input（见 --help）");
  }
  const adapter = ADAPTERS[adapterId];
  if (!adapter) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      `未知 adapter: ${adapterId}。已注册: ${listIngestAdapters().join(", ")}`,
    );
  }

  const ctx = await loadContext(Boolean(o.json));
  const pack = await loadPack();
  const queue = await createQueue(ctx.repoRoot);
  const text = await readFile(resolve(input), "utf8");
  const result = await ingestJsonl({
    repoRoot: ctx.repoRoot,
    pack,
    queue,
    brainId: ctx.brainId,
    createdBy: defaultCreatedBy(),
    defaultSourceId: (o.source as string) ?? ctx.sourceId,
    adapter,
    text,
    continueOnError: Boolean(o["continue-on-error"]),
  });

  if (o.json) {
    console.log(JSON.stringify(result));
  } else {
    for (const p of result.paths) console.log(p);
    for (const e of result.errors) {
      console.error(`line ${e.line}: ${e.message}`);
    }
  }
  return result.errors.length > 0 ? 2 : 0;
}
