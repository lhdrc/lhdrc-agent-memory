import { join, dirname } from "node:path";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdirp } from "../util/fs.ts";
import type { Turn } from "../inbox/session.ts";

export type HistoryProvenance = {
  session_id: string;
  turns: number[];
  history_ref: string;
};

export interface HistoryIndexEntry {
  md_path: string;
  session_id: string;
  turn_index: number[];
  history_ref: string;
}

export function historyIndexRel(brainId: string): string {
  return `brains/${brainId}/history_index.jsonl`;
}

export function historyIndexAbs(repoRoot: string, brainId: string): string {
  return join(repoRoot, historyIndexRel(brainId));
}

export function buildHistoryRef(sessionId: string, turns: number[]): string {
  if (turns.length === 0) return `inbox/sessions/${sessionId}/messages.jsonl`;
  const sorted = [...turns].sort((a, b) => a - b);
  // if contiguous, use dash range like #turn2-3, else comma
  let isContiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1]! + 1) {
      isContiguous = false;
      break;
    }
  }
  if (sorted.length === 1) {
    return `inbox/sessions/${sessionId}/messages.jsonl#turn${sorted[0]}`;
  }
  if (isContiguous) {
    return `inbox/sessions/${sessionId}/messages.jsonl#turn${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return `inbox/sessions/${sessionId}/messages.jsonl#turn${sorted.join(",")}`;
}

export function normalizeHistoryEntry(raw: Record<string, unknown>): HistoryIndexEntry | null {
  const md_path = typeof raw.md_path === "string" ? raw.md_path : typeof raw.path === "string" ? raw.path : "";
  const session_id = typeof raw.session_id === "string" ? raw.session_id : "";
  const history_ref = typeof raw.history_ref === "string" ? raw.history_ref : "";
  let turn_index: number[] | undefined;
  if (Array.isArray(raw.turn_index)) turn_index = raw.turn_index.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1);
  else if (Array.isArray(raw.turns)) turn_index = raw.turns.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1);
  if (!md_path || !session_id || !history_ref || !turn_index) return null;
  return { md_path, session_id, turn_index, history_ref };
}

export async function appendHistoryEntries(
  repoRoot: string,
  brainId: string,
  entries: HistoryIndexEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const abs = historyIndexAbs(repoRoot, brainId);
  await mkdirp(dirname(abs));
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(abs, lines, "utf8");
}

export async function readHistoryEntries(repoRoot: string, brainId: string): Promise<HistoryIndexEntry[]> {
  const abs = historyIndexAbs(repoRoot, brainId);
  if (!existsSync(abs)) return [];
  const raw = await readFile(abs, "utf8");
  const out: HistoryIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const norm = normalizeHistoryEntry(parsed);
      if (norm) out.push(norm);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export async function findHistoryEntriesForPath(
  repoRoot: string,
  brainId: string,
  mdPath: string,
): Promise<HistoryIndexEntry[]> {
  const all = await readHistoryEntries(repoRoot, brainId);
  const normalized = mdPath.replace(/\\/g, "/");
  return all.filter((e) => e.md_path.replace(/\\/g, "/") === normalized);
}

export async function findHistoryEntriesForSession(
  repoRoot: string,
  brainId: string,
  sessionId: string,
): Promise<HistoryIndexEntry[]> {
  const all = await readHistoryEntries(repoRoot, brainId);
  return all.filter((e) => e.session_id === sessionId);
}

/** read messages.jsonl turns filtered to user+assistant mapping for turn_index (1-based) */
export async function readHistoryTurns(
  repoRoot: string,
  brainId: string,
  sessionId: string,
  turnIndices?: number[],
): Promise<Array<{ turn_index: number; turn: Turn }>> {
  const { loadSession } = await import("../inbox/session.ts");
  const { turns } = await loadSession(repoRoot, brainId, sessionId);
  const numbered: Turn[] = turns.filter((t) => t.role === "user" || t.role === "assistant");
  if (!turnIndices || turnIndices.length === 0) {
    return numbered.map((turn, i) => ({ turn_index: i + 1, turn }));
  }
  const out: Array<{ turn_index: number; turn: Turn }> = [];
  for (const idx of turnIndices) {
    const pos = idx - 1;
    if (pos >= 0 && pos < numbered.length) {
      out.push({ turn_index: idx, turn: numbered[pos]! });
    }
  }
  return out;
}

export async function historySliceForPath(
  repoRoot: string,
  brainId: string,
  mdPath: string,
): Promise<{ entries: HistoryIndexEntry[]; history: string; turns: Array<{ turn_index: number; role: string; text: string; at?: string }> }> {
  const entries = await findHistoryEntriesForPath(repoRoot, brainId, mdPath);
  if (entries.length === 0) return { entries: [], history: "", turns: [] };
  const allTurns: Array<{ turn_index: number; role: string; text: string; at?: string }> = [];
  const texts: string[] = [];
  for (const e of entries) {
    try {
      const slice = await readHistoryTurns(repoRoot, brainId, e.session_id, e.turn_index);
      for (const s of slice) {
        allTurns.push({ turn_index: s.turn_index, role: s.turn.role, text: s.turn.text, ...(s.turn.at ? { at: s.turn.at } : {}) });
        texts.push(s.turn.text);
      }
    } catch {
      /* fail-open skip missing session */
    }
  }
  return { entries, history: texts.join("\n\n"), turns: allTurns };
}
