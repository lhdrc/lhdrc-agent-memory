import {
  MemoryError,
  ErrorCodes,
  appendLedgerEvent,
  listLedgerEvents,
} from "@lhdrc/core";
import { parseArgs } from "../args.ts";
import { loadNoSourceContext } from "../context.ts";
import { createQueue } from "../services.ts";

const HELP = `memory events list [--source <s>] [--from <iso>] [--type <t>] [--limit N] [--json]
memory events append --type <t> --payload-json '{}' [--source <s>] [--json]

账本：brains/{brainId}/events/{YYYY-MM}/ledger.jsonl
`;

export async function eventsCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP.trimEnd());
    return 0;
  }

  const ctx = await loadNoSourceContext(rest.includes("--json"));

  if (sub === "list") {
    const o = parseArgs(rest, [
      { name: "source", type: "string" },
      { name: "from", type: "string" },
      { name: "type", type: "string" },
      { name: "limit", type: "string" },
      { name: "json", type: "boolean" },
    ]);
    const limitRaw = o.limit != null ? Number(o.limit) : 50;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const events = await listLedgerEvents(ctx.repoRoot, ctx.brainId, {
      type: o.type as string | undefined,
      source: o.source as string | undefined,
      from: o.from as string | undefined,
      limit,
    });
    if (o.json) console.log(JSON.stringify({ events }));
    else {
      if (events.length === 0) console.log("(no events)");
      for (const e of events) {
        console.log(`${e.at}  ${e.type}  ${e.id}`);
      }
    }
    return 0;
  }

  if (sub === "append") {
    const o = parseArgs(rest, [
      { name: "type", type: "string" },
      { name: "payload-json", type: "string" },
      { name: "source", type: "string" },
      { name: "by", type: "string" },
      { name: "json", type: "boolean" },
    ]);
    const type = (o.type as string | undefined)?.trim();
    if (!type) {
      throw new MemoryError(ErrorCodes.USAGE, "events append 需要 --type");
    }
    let payload: Record<string, unknown> = {};
    const rawPayload = (o["payload-json"] as string | undefined) ?? "{}";
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new MemoryError(ErrorCodes.USAGE, "--payload-json 必须是 JSON 对象");
    }
    const queue = await createQueue(ctx.repoRoot);
    const event = await appendLedgerEvent(
      ctx.repoRoot,
      ctx.brainId,
      {
        type,
        by: (o.by as string | undefined) ?? "cli:user",
        source: o.source as string | undefined,
        payload,
      },
      queue,
    );
    if (o.json) console.log(JSON.stringify(event));
    else console.log(event.id);
    return 0;
  }

  throw new MemoryError(ErrorCodes.USAGE, `未知 events 子命令: ${sub}`);
}
