import { MemoryError, ErrorCodes } from "../errors.ts";
import type { Turn, TurnRole } from "../inbox/session.ts";

const ROLES = new Set<TurnRole>(["user", "assistant", "system", "tool"]);

function asTurn(raw: unknown, line: number): Turn {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `turn 第 ${line} 行必须是对象`);
  }
  const o = raw as Record<string, unknown>;
  const role = String(o.role ?? "").trim() as TurnRole;
  if (!ROLES.has(role)) {
    throw new MemoryError(ErrorCodes.VALIDATION, `turn 第 ${line} 行 role 非法: ${o.role}`);
  }
  const text = typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
  const at = typeof o.at === "string" ? o.at : undefined;
  return at ? { role, text, at } : { role, text };
}

/** JSONL（一行一个 turn）或 JSON 数组 → Turn[]。 */
export function parseSessionTurns(text: string): Turn[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new MemoryError(ErrorCodes.VALIDATION, `session JSON 无法解析: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new MemoryError(ErrorCodes.VALIDATION, "session JSON 必须是 turn 数组");
    }
    return parsed.map((row, i) => asTurn(row, i + 1));
  }
  const turns: Turn[] = [];
  let lineNo = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lineNo++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new MemoryError(ErrorCodes.VALIDATION, `session JSONL 第 ${lineNo} 行无法解析: ${e instanceof Error ? e.message : String(e)}`);
    }
    turns.push(asTurn(parsed, lineNo));
  }
  return turns;
}

const CONTEXT_BLOCK = /<df-memory-context\b[^>]*>[\s\S]*?<\/df-memory-context>/gi;

export function stripMemoryContext(text: string): string {
  return text.replace(CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripTurnsContext(turns: Turn[]): Turn[] {
  return turns.map((t) => ({ ...t, text: stripMemoryContext(t.text) }));
}

export function formatTurnsForPrompt(turns: Turn[]): string {
  const lines: string[] = [];
  let n = 0;
  for (const t of turns) {
    if (t.role === "system" || t.role === "tool") continue;
    n++;
    lines.push(`${n}. ${t.role}: ${t.text}`);
  }
  return lines.join("\n");
}

export const ALREADY_IN_KB_HEADING =
  "## Already in the knowledge base (do not re-extract; only emit genuinely new items)";

export const JSON_REPAIR_SUFFIX =
  'Previous response was not a JSON object with an "items" array. Return only that JSON object.';

export type ExistingMemoryLine = { title: string; snippet: string };

export function numberedTurnCount(turns: Turn[]): number {
  return turns.filter((t) => t.role === "user" || t.role === "assistant").length;
}

export function resolveSessionTime(turns: Turn[], now = new Date()): Date {
  for (const t of turns) {
    if (!t.at) continue;
    const d = new Date(t.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return now;
}

export function formatSessionTimeLabel(at: Date): string {
  const iso = at.toISOString();
  const weekday = at.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC (${weekday})`;
}

export function prefetchQueryText(turns: Turn[], maxChars = 500): string {
  const users = turns
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join("\n")
    .trim();
  const base =
    users ||
    turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => t.text)
      .join("\n")
      .trim();
  return base.length <= maxChars ? base : base.slice(0, maxChars);
}

export function formatCompileUserPrompt(opts: {
  turns: Turn[];
  existing?: ExistingMemoryLine[];
  now?: Date;
}): string {
  const time = formatSessionTimeLabel(resolveSessionTime(opts.turns, opts.now));
  const parts = [
    "## Session",
    `**Session Time:** ${time}`,
    "Relative times (e.g. yesterday) are based on Session Time, not the model's clock.",
    "",
  ];
  if (opts.existing && opts.existing.length > 0) {
    parts.push(ALREADY_IN_KB_HEADING);
    for (const e of opts.existing) {
      const snip = e.snippet.replace(/\s+/g, " ").trim();
      parts.push(`- ${e.title}: ${snip}`);
    }
    parts.push("");
  }
  parts.push("## Conversation");
  parts.push(formatTurnsForPrompt(opts.turns));
  return parts.join("\n");
}

export type SourceTurnsCheck = { ok: true; turns?: number[] } | { ok: false };

export function checkSourceTurns(raw: unknown, turnCount: number): SourceTurnsCheck {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.length === 0) return { ok: true, turns: [] };
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : Number(x);
    if (!Number.isInteger(n) || n < 1 || n > turnCount) return { ok: false };
    out.push(n);
  }
  return { ok: true, turns: out };
}

export function truncateTurns(turns: Turn[], maxChars: number): { turns: Turn[]; truncated: boolean } {
  const eligible = turns.filter((t) => t.role === "user" || t.role === "assistant");
  const others = turns.filter((t) => t.role !== "user" && t.role !== "assistant");
  let total = eligible.reduce((s, t) => s + t.text.length, 0);
  if (total <= maxChars) return { turns, truncated: false };
  const kept = [...eligible];
  let truncated = false;
  while (kept.length > 1 && total > maxChars) {
    const dropped = kept.shift();
    if (!dropped) break;
    total -= dropped.text.length;
    truncated = true;
  }
  const keptSet = new Set(kept);
  const ordered = turns.filter((t) => t.role === "system" || t.role === "tool" || keptSet.has(t));
  return { turns: ordered.length ? ordered : [...others, ...kept], truncated };
}

export function parseCompleteItemsJson(text: string): unknown[] {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/im.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new MemoryError(ErrorCodes.LLM, "complete 响应不是 JSON 对象");
  }
  s = s.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new MemoryError(ErrorCodes.LLM, `complete JSON.parse 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new MemoryError(ErrorCodes.LLM, "complete 响应缺少 items 数组");
  }
  return (parsed as { items: unknown[] }).items;
}
