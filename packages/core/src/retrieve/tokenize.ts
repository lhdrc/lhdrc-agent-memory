import { bigrams } from "./ngrams.ts";

/**
 * P14.1 分流分词：输入已 cleanForIndex(...,'bm25') 的小写归一文本
 * - 英文流：[a-z0-9]+(?:'[a-z]+)? 抽词，连字符/下划线/点作分隔，双存整形+拆分
 * - 中文流：[\p{Script=Han}] 抽汉字后滑字二元
 * - 数字归英文流；字母数字混排整形+拆分双存
 */
export function tokenizeMixed(clean: string): { cjkBigrams: string; enWords: string } {
  if (!clean) return { cjkBigrams: "", enWords: "" };
  const lower = clean.toLowerCase();

  // 中文流：抽全部汉字字符后 bigrams
  const hanChars = (lower.match(/\p{Script=Han}/gu) ?? []).join("");
  const cjkBigrams = bigrams(hanChars);

  // 英文流：抽词
  const wordRe = /[a-z0-9]+(?:'[a-z]+)?/g;
  const words = lower.match(wordRe) ?? [];

  const enTokens: string[] = [...words];

  // 整形+拆分：连字符/下划线/点连接的复合词保留整形
  const compoundRe = /[a-z0-9]+(?:[-_.][a-z0-9]+)+/g;
  const compounds = lower.match(compoundRe) ?? [];
  for (const c of compounds) {
    if (!enTokens.includes(c)) enTokens.push(c);
  }

  // 字母数字混排拆分双存：如 p13 v2 retry2
  const extra: string[] = [];
  for (const w of words) {
    if (/[a-z]/.test(w) && /\d/.test(w)) {
      const parts = w.match(/[a-z]+|\d+/g) ?? [];
      for (const p of parts) {
        if (p !== w && !enTokens.includes(p) && !extra.includes(p)) {
          extra.push(p);
        }
      }
    }
  }
  // 复合词本身若为混排（如 p13.1），其拆分可能已在 words 拆分中覆盖，但确保点分割的数字也单独保留
  // 例如 p13.1 -> compounds 含 p13.1，words 含 p13,1；extra 已含 p,13；已完整

  if (extra.length) enTokens.push(...extra);

  return { cjkBigrams, enWords: enTokens.join(" ") };
}
