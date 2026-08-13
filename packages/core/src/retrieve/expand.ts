const STOP_EN = new Set(["the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "at"]);
const STOP_ZH = new Set(["的", "了", "吗", "呢", "是", "在", "和", "与", "或", "及", "等", "被", "把", "就", "都", "也"]);

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.replace(/\s+/g, " ").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function stripStopwords(q: string): string {
  const parts = q.split(/(\s+)/);
  const kept = parts.filter((p) => {
    if (/^\s+$/.test(p)) return true;
    const low = p.toLowerCase();
    if (STOP_EN.has(low)) return false;
    if ([...p].every((ch) => STOP_ZH.has(ch))) return false;
    return true;
  });
  let s = kept.join("").replace(/\s+/g, " ").trim();
  // 去中文停用字
  s = [...s].filter((ch) => !STOP_ZH.has(ch)).join("").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * P5.3 启发式扩写：原查询 + 去停用词 / 字间空格 / 词序变体。不联网。
 * 返回 [original, ...最多 expandN 条变体]。
 */
export function heuristicExpand(query: string, expandN = 2): string[] {
  const q = query.trim();
  if (!q) return [];
  const variants: string[] = [q];
  const stripped = stripStopwords(q);
  if (stripped && stripped !== q) variants.push(stripped);

  const hans = [...q].filter((ch) => /\p{Script=Han}/u.test(ch));
  if (hans.length >= 2) variants.push(hans.join(" "));

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) variants.push([...tokens].reverse().join(" "));

  if (variants.length < 2) variants.push(`${q} 相关`);

  return unique(variants).slice(0, 1 + Math.max(0, expandN));
}
