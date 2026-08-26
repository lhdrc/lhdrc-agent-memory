import { extractValueTokens } from "../write/dedupe.ts";

/**
 * P11.5：去掉 P11.3 值 token 后，剩余字母/汉字作为槽位骨架。
 * 保留 lives/works 等小写谓词，才能区分「住哪」与「任职」。
 */
export function slotSkeleton(text: string): string {
  let s = text.normalize("NFKC");
  for (const tok of extractValueTokens(s)) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(escaped, "gi"), " ");
  }
  return s.replace(/[^\p{L}\p{Script=Han}]+/gu, "").toLowerCase();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  if (s.length < 3) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function trigramJaccard(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) {
    if (tb.has(x)) inter++;
  }
  return inter / (ta.size + tb.size - inter);
}

/**
 * 同一槽位：骨架 trigram Jaccard ≥ 0.5，且两边都有值 token、集合不同。
 * 全等文本由 caller 当幂等，本函数仍可返回 true。
 */
export function sameEntitySlot(existing: string, incoming: string): boolean {
  const va = extractValueTokens(existing);
  const vb = extractValueTokens(incoming);
  if (va.size === 0 || vb.size === 0) return false;
  let aOnly = false;
  let bOnly = false;
  for (const x of va) {
    if (!vb.has(x)) aOnly = true;
  }
  for (const x of vb) {
    if (!va.has(x)) bOnly = true;
  }
  if (!aOnly && !bOnly) return false;
  return trigramJaccard(slotSkeleton(existing), slotSkeleton(incoming)) >= 0.5;
}
