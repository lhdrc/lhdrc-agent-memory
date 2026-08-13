import { join } from "node:path";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdirp } from "../util/fs.ts";
import type { FileMutationExecutor } from "../write/executor.ts";

function monthDir(iso: string): string {
  return iso.slice(0, 7);
}

export interface LedgerEvent {
  id: string;
  type: string;
  at: string;
  by?: string;
  source?: string;
  from?: unknown;
  payload?: Record<string, unknown>;
}

export interface ListLedgerOptions {
  type?: string;
  source?: string;
  from?: string;
  limit?: number;
}

function eventId(): string {
  return `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function ledgerRel(brainId: string, at = new Date().toISOString()): string {
  return `brains/${brainId}/events/${monthDir(at)}/ledger.jsonl`;
}

export function newLedgerEvent(
  partial: Omit<LedgerEvent, "id" | "at"> & { id?: string; at?: string },
): LedgerEvent {
  return {
    id: partial.id ?? eventId(),
    type: partial.type,
    at: partial.at ?? new Date().toISOString(),
    by: partial.by,
    source: partial.source,
    from: partial.from,
    payload: partial.payload,
  };
}

export function serializeLedgerEvent(e: LedgerEvent): string {
  const row: Record<string, unknown> = { id: e.id, type: e.type, at: e.at };
  if (e.by != null) row.by = e.by;
  if (e.source != null) row.source = e.source;
  if (e.from != null) row.from = e.from;
  if (e.payload != null) row.payload = e.payload;
  return JSON.stringify(row);
}

export function parseLedgerLine(line: string): LedgerEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const type = String(raw.type ?? "");
    if (!type) return null;
    const at = String(raw.at ?? "");
    const payload =
      raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : undefined;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (["id", "type", "at", "by", "source", "from", "payload"].includes(k)) continue;
      extra[k] = v;
    }
    return {
      id: String(raw.id ?? `evt_${at}_${type}`),
      type,
      at,
      by: raw.by != null ? String(raw.by) : undefined,
      source: raw.source != null ? String(raw.source) : payload?.source != null ? String(payload.source) : undefined,
      from: raw.from,
      payload: payload ?? (Object.keys(extra).length ? extra : undefined),
    };
  } catch {
    return null;
  }
}

export async function appendLedgerEvent(
  repoRoot: string,
  brainId: string,
  partial: Omit<LedgerEvent, "id" | "at"> & { id?: string; at?: string },
  queue?: FileMutationExecutor,
): Promise<LedgerEvent> {
  const event = newLedgerEvent(partial);
  const rel = ledgerRel(brainId, event.at);
  const write = async () => {
    const abs = join(repoRoot, rel);
    await mkdirp(join(repoRoot, "brains", brainId, "events", monthDir(event.at)));
    await appendFile(abs, `${serializeLedgerEvent(event)}\n`, "utf8");
    return [rel];
  };
  if (queue) {
    await queue.execute(write, `events append ${event.type}`);
  } else {
    await write();
  }
  return event;
}

function matchesFromDate(at: string, from: string): boolean {
  const a = Date.parse(at);
  const f = Date.parse(from);
  if (Number.isFinite(a) && Number.isFinite(f)) return a >= f;
  return at >= from;
}

export async function listLedgerEvents(
  repoRoot: string,
  brainId: string,
  opts: ListLedgerOptions = {},
): Promise<LedgerEvent[]> {
  const eventsDir = join(repoRoot, "brains", brainId, "events");
  if (!existsSync(eventsDir)) return [];
  const months = (await readdir(eventsDir)).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  const limit = opts.limit ?? 50;
  const out: LedgerEvent[] = [];

  for (const m of months) {
    const file = join(eventsDir, m, "ledger.jsonl");
    if (!existsSync(file)) continue;
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const e = parseLedgerLine(lines[i]!);
      if (!e) continue;
      if (opts.type && e.type !== opts.type) continue;
      if (opts.source && e.source !== opts.source) continue;
      if (opts.from && !matchesFromDate(e.at, opts.from)) continue;
      out.push(e);
    }
  }
  return out;
}

/** 在已持锁的 mutation 内写一行（调用方负责把 rel 列入 changed）。 */
export async function writeLedgerLine(
  repoRoot: string,
  brainId: string,
  event: LedgerEvent,
): Promise<string> {
  const rel = ledgerRel(brainId, event.at);
  const abs = join(repoRoot, rel);
  await mkdirp(join(repoRoot, "brains", brainId, "events", monthDir(event.at)));
  await appendFile(abs, `${serializeLedgerEvent(event)}\n`, "utf8");
  return rel;
}
