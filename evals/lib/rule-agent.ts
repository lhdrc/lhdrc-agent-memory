/** 规则代理：在检索命中文本中找 gold 子串（P5.6 蒸馏 bench，无 LLM）。 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export function hitsToBlob(hits: Array<{ title?: string; snippet?: string; path?: string }>): string {
  return hits.map((h) => `${h.title ?? ""}\n${h.snippet ?? ""}\n${h.path ?? ""}`).join("\n");
}

/** Adapter 评测：拼 title/snippet/path，并尽量读入命中 md 正文（避免 snippet 窗截断导致假阴性）。 */
export async function hitsToEvalBlob(
  repoRoot: string | undefined,
  hits: Array<{ title?: string; snippet?: string; path?: string }>,
): Promise<string> {
  const parts: string[] = [hitsToBlob(hits)];
  if (!repoRoot) return parts.join("\n");
  for (const h of hits) {
    const rel = h.path?.replace(/\\/g, "/");
    if (!rel) continue;
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      parts.push(await readFile(abs, "utf8"));
    } catch {
      /* fail-open */
    }
  }
  return parts.join("\n");
}

export function goldHit(blob: string, gold: string | string[]): boolean {
  const hay = blob.toLowerCase();
  const needles = Array.isArray(gold) ? gold : [gold];
  return needles.every((g) => hay.includes(g.toLowerCase()));
}

export function recall(hits: boolean[]): { n: number; hits: number; recall: number } {
  const n = hits.length;
  const h = hits.filter(Boolean).length;
  return { n, hits: h, recall: n === 0 ? 0 : h / n };
}
