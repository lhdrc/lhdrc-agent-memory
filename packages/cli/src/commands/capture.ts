import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  MemoryError,
  ErrorCodes,
  loadPack,
  todayUtc,
  assertSourceScope,
  parseFrontmatter,
  acceptCaptureJob,
  getJobRunner,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadContext } from "../context.ts";
import { createQueue } from "../services.ts";

function defaultCreatedBy(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? "user"}`;
}

function envExtractEnabled(): boolean {
  const v = process.env.DF_MEMORY_EXTRACT;
  return v === "1" || v === "true";
}

async function printCaptureDone(
  repoRoot: string,
  path: string,
  json: boolean,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (json) {
    const out: Record<string, unknown> = { path, ...extra };
    try {
      const raw = await readFile(resolve(repoRoot, path), "utf8");
      const links = parseFrontmatter(raw).data.links;
      if (Array.isArray(links)) {
        out.links = links.map((l) => ({ to: (l as { to?: unknown }).to }));
      }
    } catch {
      /* 读链失败仍返回 path */
    }
    console.log(JSON.stringify(out));
  } else console.log(path);
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
    { name: "extract", type: "boolean" },
    { name: "no-dedupe", type: "boolean" },
    { name: "json", type: "boolean" },
    { name: "wait", type: "boolean" },
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
  const job = await acceptCaptureJob({
    repoRoot: ctx.repoRoot,
    brainId: ctx.brainId,
    pack,
    queue,
    extract: Boolean(o.extract) || envExtractEnabled(),
    noDedupe: Boolean(o["no-dedupe"]),
    capture: {
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
    },
  });

  if (!o.wait) {
    if (o.json) {
      console.log(JSON.stringify({ accepted: true, task_id: job.task_id, status: "pending" }));
    } else {
      console.log(`accepted=true task_id=${job.task_id}`);
    }
    return 0;
  }

  const done = await getJobRunner(ctx.repoRoot, ctx.brainId).wait(job.task_id, job.timeoutMs);
  if (done.status === "failed") {
    throw new MemoryError(
      (done.error?.code as typeof ErrorCodes.JOB) ?? ErrorCodes.JOB,
      done.error?.message ?? "capture job failed",
    );
  }
  const path = String((done.output as { kept?: Array<{ path?: string }> } | undefined)?.kept?.[0]?.path ?? "");
  if (!path) {
    throw new MemoryError(ErrorCodes.JOB, "capture job done but path missing");
  }
  await printCaptureDone(ctx.repoRoot, path, Boolean(o.json), {
    task_id: done.task_id,
    status: "done",
  });
  return 0;
}
