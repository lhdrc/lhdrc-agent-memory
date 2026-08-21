import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueryHit } from "../../packages/core/src/index.ts";
import type { HaluMemMemoryPoint, HaluMemQuestion, HaluMemSession } from "./halumem.ts";
import {
  formatOfficialRetrievalContext,
  keyMemoryPointsFromQuestion,
} from "./halumem-prompts.ts";

export type QaVerdict = "Correct" | "Hallucination" | "Omission";
export type UpdateVerdict = "Correct" | "Hallucination" | "Omission" | "Other";

export function parseJsonField(text: string, keys: string[]): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    for (const k of keys) {
      const v = j[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]!) as Record<string, unknown>;
        for (const k of keys) {
          const v = j[k];
          if (v != null && String(v).trim()) return String(v).trim();
        }
      } catch {
        /* fall through */
      }
    }
  }
  return "";
}

export function parseIntegrityScore(text: string): 0 | 1 | 2 {
  const s = parseJsonField(text, ["score"]);
  if (s === "2") return 2;
  if (s === "1") return 1;
  return 0;
}

export function parseQaVerdict(text: string): QaVerdict {
  const v = parseJsonField(text, ["evaluation_result", "verdict", "label"]).toLowerCase();
  if (v.includes("hallucination")) return "Hallucination";
  if (v.includes("omission")) return "Omission";
  if (v.includes("correct")) return "Correct";
  const u = String(text ?? "").toUpperCase();
  if (u.includes("HALLUCINATION")) return "Hallucination";
  if (u.includes("OMISSION")) return "Omission";
  if (u.includes("CORRECT")) return "Correct";
  return "Omission";
}

export function parseUpdateVerdict(text: string): UpdateVerdict {
  const v = parseJsonField(text, ["evaluation_result", "verdict", "label"]).toLowerCase();
  if (v.includes("hallucination")) return "Hallucination";
  if (v.includes("omission")) return "Omission";
  if (v.includes("other")) return "Other";
  if (v.includes("correct")) return "Correct";
  const u = String(text ?? "").toUpperCase();
  if (u.includes("HALLUCINATION")) return "Hallucination";
  if (u.includes("OMISSION")) return "Omission";
  if (u.includes("OTHER")) return "Other";
  if (u.includes("CORRECT")) return "Correct";
  return "Other";
}

export function hitsToOfficialMemoryLines(hits: QueryHit[]): string[] {
  return hits.map((h) => {
    const ts = h.updatedAt?.trim() || "unknown";
    const body = [h.title, h.abstract?.trim(), h.snippet?.trim()].filter(Boolean).join(" — ");
    return `${ts}: ${body}`;
  });
}

export function formatExtractedMemoriesList(lines: string[]): string {
  if (lines.length === 0) return "(none)";
  return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

export function formatDialogue(sess: HaluMemSession): string {
  return sess.dialogue
    .map((d) => `${d.role}: ${String(d.content ?? "").trim()}`)
    .filter((l) => l.length > 2)
    .join("\n");
}

export function formatGoldenMemories(mps: HaluMemMemoryPoint[]): string {
  return mps
    .filter((m) => m.memory_source !== "interference")
    .map((m, i) => `${i + 1}. ${m.memory_content}`)
    .join("\n");
}

export function originalMemoryText(mp: HaluMemMemoryPoint): string {
  const orig = mp.original_memories?.join("\n") ?? mp.memories_from_system?.join("\n") ?? "";
  return orig.trim() || "(none)";
}

export function qaKeyPoints(qa: HaluMemQuestion): string {
  return keyMemoryPointsFromQuestion(qa);
}

export function buildOfficialRetrievalContext(userId: string, hits: QueryHit[]): string {
  return formatOfficialRetrievalContext(userId, hitsToOfficialMemoryLines(hits));
}

export async function readAllL0MemoryLines(
  repoRoot: string,
  brainId: string,
): Promise<string[]> {
  const root = join(repoRoot, "brains", brainId, "sources");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const text = await readFile(abs, "utf8");
        const title = text.match(/^title:\s*(.+)$/m)?.[1]?.trim();
        const body = text.replace(/^---[\s\S]*?---\s*/m, "").trim();
        out.push([title, body].filter(Boolean).join("\n"));
      }
    }
  }
  await walk(root);
  return out;
}

export function aggregateQaMetrics(rows: Array<{ verdict: QaVerdict }>): {
  n: number;
  correct: number;
  hallucination: number;
  omission: number;
  correct_ratio: number;
} {
  const n = rows.length;
  let correct = 0;
  let hallucination = 0;
  let omission = 0;
  for (const r of rows) {
    if (r.verdict === "Correct") correct++;
    else if (r.verdict === "Hallucination") hallucination++;
    else omission++;
  }
  return {
    n,
    correct,
    hallucination,
    omission,
    correct_ratio: n === 0 ? 0 : correct / n,
  };
}

export function aggregateUpdateMetrics(rows: Array<{ verdict: UpdateVerdict }>): {
  n: number;
  correct: number;
  hallucination: number;
  omission: number;
  other: number;
  correct_ratio: number;
} {
  const n = rows.length;
  let correct = 0;
  let hallucination = 0;
  let omission = 0;
  let other = 0;
  for (const r of rows) {
    if (r.verdict === "Correct") correct++;
    else if (r.verdict === "Hallucination") hallucination++;
    else if (r.verdict === "Omission") omission++;
    else other++;
  }
  return {
    n,
    correct,
    hallucination,
    omission,
    other,
    correct_ratio: n === 0 ? 0 : correct / n,
  };
}
