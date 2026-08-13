import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MemoryError,
  ErrorCodes,
  loadPack,
  ingestJsonl,
  type IngestAdapter,
} from "@df-memory/core";
import { genericJsonlAdapter } from "@df-memory/ingest-generic-jsonl";
import { dfAppAdapter } from "@df-memory/ingest-df-app";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

const ADAPTERS: Record<string, IngestAdapter> = {
  "generic-jsonl": genericJsonlAdapter,
  "df-app": dfAppAdapter,
};

const HELP = `memory ingest --list-adapters
memory ingest --adapter <id> --input <file> [--json] [--continue-on-error] [--source <id>]

批量摄取。写入只走 validateWrite + WriteQueue / captureNode，不直写 sources。

  --adapter            generic-jsonl | df-app
  --input              JSONL 或 JSON 数组文件
  --continue-on-error  跳过坏行，好行仍落盘；有错误时退出码 2
  --json               输出 paths / errors
  --list-adapters      列出已注册适配器

退出码：全成功 0；校验/非法行 2。默认遇到坏行即停且不写该行。
`;

export function listIngestAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

export async function ingestCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "adapter", type: "string" },
    { name: "input", type: "string" },
    { name: "source", type: "string" },
    { name: "continue-on-error", type: "boolean" },
    { name: "list-adapters", type: "boolean" },
    { name: "json", type: "boolean" },
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
  if (!adapterId || !input) {
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
    createdBy: `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`,
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
