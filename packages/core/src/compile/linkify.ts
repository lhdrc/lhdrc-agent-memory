import { stripCodeBlocks } from "../graph/link-extraction.ts";
import type { Entity } from "../entity/types.ts";

export interface LinkifyHit {
  to: string;
  type: "mentions";
}

function isAsciiWord(s: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 用 entity slug + aliases 挂 @slug。最长匹配；已是 @slug 不包；别名 ≥2 字；英文 \\b。
 */
export function linkifyBody(
  body: string,
  entities: Entity[],
): { body: string; links: LinkifyHit[] } {
  const { text: stripped } = stripCodeBlocks(body);
  type Needle = { needle: string; slug: string; english: boolean };
  const needles: Needle[] = [];
  for (const e of entities) {
    if (e.status === "merged") continue;
    needles.push({ needle: e.slug, slug: e.slug, english: isAsciiWord(e.slug) });
    if (e.title && e.title.length >= 2) {
      needles.push({ needle: e.title, slug: e.slug, english: isAsciiWord(e.title) });
    }
    for (const a of e.aliases ?? []) {
      if (a.length >= 2) needles.push({ needle: a, slug: e.slug, english: isAsciiWord(a) });
    }
  }
  needles.sort((a, b) => b.needle.length - a.needle.length);

  const claimed: Array<[number, number]> = [];
  const replacements: Array<{ start: number; end: number; slug: string }> = [];
  const linked = new Set<string>();

  for (const n of needles) {
    if (!n.needle) continue;
    const re = n.english
      ? new RegExp(`\\b${escapeRe(n.needle)}\\b`, "g")
      : new RegExp(escapeRe(n.needle), "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped))) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > 0 && stripped[start - 1] === "@") continue;
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      claimed.push([start, end]);
      replacements.push({ start, end, slug: n.slug });
      linked.add(n.slug);
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let out = body;
  for (const r of replacements) {
    out = `${out.slice(0, r.start)}@${r.slug}${out.slice(r.end)}`;
  }
  return {
    body: out,
    links: [...linked].map((to) => ({ to, type: "mentions" as const })),
  };
}
