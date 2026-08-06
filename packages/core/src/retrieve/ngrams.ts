/** 字符 bigram 化，空格连接（中文检索核心，specs/mvp/M3 §6）。 */
export function bigrams(text: string): string {
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= 1) return compact;
  const out: string[] = [];
  for (let i = 0; i < compact.length - 1; i++) {
    out.push(compact.slice(i, i + 2));
  }
  return out.join(" ");
}

export function containsBigram(ngramText: string, query: string): boolean {
  if (!query) return false;
  if (ngramText.includes(query)) return true;
  const qb = bigrams(query);
  if (!qb) return false;
  return qb.split(" ").every((g) => ngramText.split(" ").includes(g));
}
