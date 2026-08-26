import { join } from "node:path";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdirp } from "../util/fs.ts";
import { monthDir } from "../entity/registry.ts";

export type MemoryDiffOp =
  | "create"
  | "experience_create"
  | "experience_merge"
  | "experience_supersede"
  | "abstract_update"
  | "skill_create"
  | "skill_activate"
  | "skill_outcome"
  | "skill_archive"
  | "skip_duplicate"
  | "noop";

export interface MemoryDiffEntry {
  id: string;
  at: string;
  op: MemoryDiffOp;
  paths_written: string[];
  paths_readonly_refs: string[];
  decision: Record<string, unknown>;
  revert?: {
    action: "archive_path" | "restore_snapshot" | "none" | string;
    path?: string;
    snapshot?: {
      procedure?: string;
      boundary?: string;
      body?: string;
      status?: string;
    };
  };
}

function diffId(): string {
  return `diff_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function memoryDiffRel(brainId: string, at = new Date().toISOString()): string {
  return `brains/${brainId}/events/${monthDir(at)}/memory_diff.jsonl`;
}

export async function appendMemoryDiff(
  repoRoot: string,
  brainId: string,
  entry: Omit<MemoryDiffEntry, "id" | "at"> & { id?: string; at?: string },
): Promise<MemoryDiffEntry> {
  const at = entry.at ?? new Date().toISOString();
  const full: MemoryDiffEntry = {
    id: entry.id ?? diffId(),
    at,
    op: entry.op,
    paths_written: entry.paths_written,
    paths_readonly_refs: entry.paths_readonly_refs,
    decision: entry.decision,
    revert: entry.revert,
  };
  const rel = memoryDiffRel(brainId, at);
  const abs = join(repoRoot, rel);
  await mkdirp(join(repoRoot, "brains", brainId, "events", monthDir(at)));
  await appendFile(abs, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** 列出最近 memory_diff 条目（跨月倒序）。 */
export async function listMemoryDiffs(
  repoRoot: string,
  brainId: string,
  limit = 20,
): Promise<MemoryDiffEntry[]> {
  const eventsDir = join(repoRoot, "brains", brainId, "events");
  if (!existsSync(eventsDir)) return [];

  const months = (await readdir(eventsDir)).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  const out: MemoryDiffEntry[] = [];

  for (const m of months) {
    const file = join(eventsDir, m, "memory_diff.jsonl");
    if (!existsSync(file)) continue;
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as MemoryDiffEntry);
      } catch {
        /* skip malformed */
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export async function findMemoryDiff(
  repoRoot: string,
  brainId: string,
  diffId: string,
): Promise<MemoryDiffEntry | null> {
  const all = await listMemoryDiffs(repoRoot, brainId, 500);
  return all.find((d) => d.id === diffId) ?? null;
}
