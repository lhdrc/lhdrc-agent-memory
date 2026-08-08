import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { MemoryError, ErrorCodes, loadPack, captureNode, todayUtc, assertSourceScope } from "@df-memory/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

function defaultCreatedBy(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
}

export async function captureCommand(argv: string[]): Promise<number> {
  const o = parseArgs(argv, [
    { name: "title", type: "string" },
    { name: "type", type: "string" },
    { name: "body", type: "string" },
    { name: "body-file", type: "string" },
    { name: "source", type: "string" },
    { name: "issue", type: "string" },
    { name: "tag", type: "string[]" },
    { name: "alias", type: "string[]" },
    { name: "fact", type: "string[]" },
    { name: "created-by", type: "string" },
    { name: "json", type: "boolean" },
  ]);
  if (!o.title || !o.type) {
    throw new MemoryError(ErrorCodes.USAGE, "capture 需要 --title 与 --type");
  }
  const ctx = await loadContext(Boolean(o.json));
  const createdBy = (o["created-by"] as string) ?? defaultCreatedBy();
  const type = o.type as string;
  const sourceId = (o.source as string) ?? ctx.sourceId;
  assertSourceScope(ctx.auth, sourceId);

  let body: string;
  if (o.body !== undefined) body = String(o.body);
  else if (o["body-file"]) body = await readFile(resolve(String(o["body-file"])), "utf8");
  else if (!process.stdin.isTTY) body = await new Response(Bun.stdin).text();
  else throw new MemoryError(ErrorCodes.USAGE, "capture 需要 --body / --body-file / stdin");

  const facts = ((o.fact as string[]) ?? []).map((t) => ({
    text: t,
    event_type: type,
    attributed_to: createdBy,
    at: todayUtc(),
  }));

  const pack = await loadPack();
  const queue = await createQueue(ctx.repoRoot);
  const path = await captureNode(ctx.repoRoot, pack, queue, {
    brainId: ctx.brainId,
    sourceId,
    schemaType: type,
    title: String(o.title),
    body,
    issue: o.issue as string | undefined,
    tags: (o.tag as string[]) ?? undefined,
    aliases: (o.alias as string[]) ?? undefined,
    facts,
    createdBy,
  });

  if (o.json) console.log(JSON.stringify({ path }));
  else console.log(path);
  return 0;
}
