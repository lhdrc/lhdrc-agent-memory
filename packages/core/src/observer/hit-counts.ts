import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirp } from "../util/fs.ts";

export const HIT_COUNTS_REL = ".dfmemory/logs/hit-counts.json";

export type HitCountsFile = { v: 1; counts: Record<string, number> };

export async function readHitCounts(repoRoot: string): Promise<HitCountsFile> {
  const abs = join(repoRoot, HIT_COUNTS_REL);
  if (!existsSync(abs)) return { v: 1, counts: {} };
  try {
    const raw = JSON.parse(await readFile(abs, "utf8")) as { counts?: unknown };
    if (!raw?.counts || typeof raw.counts !== "object" || Array.isArray(raw.counts)) {
      return { v: 1, counts: {} };
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.counts as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) counts[k.replace(/\\/g, "/")] = Math.floor(n);
    }
    return { v: 1, counts };
  } catch {
    return { v: 1, counts: {} };
  }
}

export async function bumpHitCounts(repoRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const current = await readHitCounts(repoRoot);
  for (const p of paths) {
    const key = p.replace(/\\/g, "/");
    if (!key) continue;
    current.counts[key] = (current.counts[key] ?? 0) + 1;
  }
  const abs = join(repoRoot, HIT_COUNTS_REL);
  await mkdirp(dirname(abs));
  await writeFile(abs, `${JSON.stringify(current)}\n`, "utf8");
}
