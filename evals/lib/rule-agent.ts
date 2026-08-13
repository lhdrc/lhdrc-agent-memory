/** 规则代理：在检索命中文本中找 gold 子串（P5.6 蒸馏 bench，无 LLM）。 */

export function hitsToBlob(hits: Array<{ title?: string; snippet?: string; path?: string }>): string {
  return hits.map((h) => `${h.title ?? ""}\n${h.snippet ?? ""}\n${h.path ?? ""}`).join("\n");
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
