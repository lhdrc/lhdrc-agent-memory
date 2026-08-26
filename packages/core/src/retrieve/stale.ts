import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBrainRoot } from "../repo/layout.ts";

export type StalePair = { a: string; b: string };

export type StaleDemoteExplain = { path: string; pair: string; factor: number };

const CROSS_RE = /- duplicate cosine=\S+\s+`([^`]+)`[\s\S]*?`([^`]+)`/g;

export function parseCrossFilePairs(md: string): StalePair[] {
  const heading = md.search(/^##\s+cross-file\s*$/m);
  if (heading < 0) return [];
  let section = md.slice(heading);
  const next = section.slice(1).search(/\n##\s+/);
  if (next >= 0) section = section.slice(0, next + 1);
  const pairs: StalePair[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(CROSS_RE.source, "g");
  while ((m = re.exec(section)) && pairs.length < 100) {
    const a = m[1]!.replace(/\\/g, "/").trim();
    const b = m[2]!.replace(/\\/g, "/").trim();
    if (a && b && a !== b) pairs.push({ a, b });
  }
  return pairs;
}

export function olderPathOfPair(a: string, b: string, updatedAt: Map<string, string>): string {
  const ta = Date.parse(updatedAt.get(a) ?? "");
  const tb = Date.parse(updatedAt.get(b) ?? "");
  const aOk = Number.isFinite(ta);
  const bOk = Number.isFinite(tb);
  if (aOk && bOk) return ta <= tb ? a : b;
  return a < b ? b : a;
}

export function applyStaleDemote<T extends { path: string; score: number }>(
  hits: T[],
  pairs: StalePair[],
  updatedAt: Map<string, string>,
  factor: number,
): { hits: T[]; explain: StaleDemoteExplain[] } {
  const f = Number.isFinite(factor) && factor > 0 && factor <= 1 ? factor : 0.85;
  const mul = new Map<string, number>();
  const explain: StaleDemoteExplain[] = [];
  for (const p of pairs) {
    const older = olderPathOfPair(p.a, p.b, updatedAt);
    const next = Math.max(0.5, (mul.get(older) ?? 1) * f);
    mul.set(older, next);
    explain.push({ path: older, pair: `${p.a}↔${p.b}`, factor: f });
  }
  const nextHits = hits
    .map((h) => {
      const m = mul.get(h.path.replace(/\\/g, "/"));
      return m != null ? { ...h, score: h.score * m } : h;
    })
    .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
  return { hits: nextHits, explain };
}

export async function loadCrossFilePairs(repoRoot: string, brainId: string): Promise<StalePair[]> {
  const abs = join(resolveBrainRoot(repoRoot, brainId), "contradictions.md");
  if (!existsSync(abs)) return [];
  try {
    return parseCrossFilePairs(await readFile(abs, "utf8"));
  } catch {
    return [];
  }
}
