import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { heuristicAbstract, heuristicOverview, overviewSidecarRel } from "../layers/generate.ts";
import { resolveNodeRelPath } from "./paths.ts";

export type MemoryLayer = "l0" | "l1" | "l2";

export interface ReadResult {
  rel: string;
  raw: string;
  layer: MemoryLayer;
  content: string;
  chars: number;
  provenance?: unknown;
}

export interface ReadResultWithHistory extends ReadResult {
  history: string;
  historyTurns: Array<{ turn_index: number; role: string; text: string; at?: string }>;
  historyEntries: Array<{ md_path: string; session_id: string; turn_index: number[]; history_ref: string }>;
}

export function parseMemoryLayer(raw: unknown): MemoryLayer {
  const v = String(raw ?? "l2").toLowerCase();
  if (v === "l0" || v === "l1" || v === "l2") return v;
  throw new MemoryError(ErrorCodes.USAGE, `--layer 必须是 l0|l1|l2，收到: ${String(raw)}`);
}

export async function readNode(
  repoRoot: string,
  brainId: string,
  input: string,
  opts?: { layer?: MemoryLayer; withHistory?: false },
): Promise<ReadResult>;
export async function readNode(
  repoRoot: string,
  brainId: string,
  input: string,
  opts: { layer?: MemoryLayer; withHistory: true },
): Promise<ReadResultWithHistory>;
export async function readNode(
  repoRoot: string,
  brainId: string,
  input: string,
  opts?: { layer?: MemoryLayer; withHistory?: boolean },
): Promise<ReadResult | ReadResultWithHistory> {
  const layer = opts?.layer ?? "l2";
  const rel = resolveNodeRelPath(repoRoot, brainId, input);
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, rel), "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${rel}`);
  }

  let content: string;
  if (layer === "l2") {
    content = raw;
  } else if (layer === "l0") {
    const { data, body } = parseFrontmatter(raw);
    const a = typeof data.abstract === "string" ? data.abstract.trim() : "";
    content = a || heuristicAbstract(body);
  } else {
    const { data, body } = parseFrontmatter(raw);
    const sidecarHint = typeof data.overview_sidecar === "string" ? data.overview_sidecar : overviewSidecarRel(rel);
    let sidecarText = "";
    try {
      sidecarText = await readFile(join(repoRoot, sidecarHint), "utf8");
    } catch {
      sidecarText = "";
    }
    const o = typeof data.overview === "string" ? data.overview.trim() : "";
    content = sidecarText.trim() || o || heuristicOverview(body);
  }

  const base: ReadResult = { rel, raw, layer, content, chars: content.length };

  // attach provenance from frontmatter if present
  try {
    const { data } = parseFrontmatter(raw);
    if (data.provenance) base.provenance = data.provenance;
  } catch {
    /* ignore */
  }

  if (!opts?.withHistory) {
    return base;
  }

  const extended: ReadResultWithHistory = { ...base, history: "", historyTurns: [], historyEntries: [] };
  try {
    const { historySliceForPath } = await import("../history/index.ts");
    const slice = await historySliceForPath(repoRoot, brainId, rel);
    if (slice.entries.length > 0) {
      extended.historyEntries = slice.entries;
      extended.history = slice.history;
      extended.historyTurns = slice.turns;
      // fallback provenance from sidecar if frontmatter missing
      if (!extended.provenance && slice.entries.length > 0) {
        const first = slice.entries[0]!;
        extended.provenance = { session_id: first.session_id, turns: first.turn_index, history_ref: first.history_ref };
      }
    } else if (extended.provenance) {
      // try to resolve history via frontmatter provenance even without sidecar
      const prov = extended.provenance as Record<string, unknown>;
      const sid = typeof prov.session_id === "string" ? prov.session_id : typeof prov.sessionId === "string" ? prov.sessionId : "";
      const turnsRaw = Array.isArray(prov.turns) ? prov.turns : Array.isArray((prov as Record<string, unknown>).turn_index) ? (prov as Record<string, unknown>).turn_index as unknown[] : [];
      const turnsArr = (turnsRaw as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 1);
      if (sid && turnsArr.length > 0) {
        const { readHistoryTurns } = await import("../history/index.ts");
        const slice2 = await readHistoryTurns(repoRoot, brainId, sid, turnsArr);
        extended.historyTurns = slice2.map((s) => ({ turn_index: s.turn_index, role: s.turn.role, text: s.turn.text, ...(s.turn.at ? { at: s.turn.at } : {}) }));
        extended.history = slice2.map((s) => s.turn.text).join("\n\n");
      }
    }
  } catch {
    /* fail-open */
  }

  return extended;
}
