import type { Fact, ValidationError } from "./types.ts";

const SKIP_HEADINGS = new Set(["摘要", "正文"]);
const LIST_ITEM_RE = /^[\s>*-]*[*-]\s+(.+)$/;
const HEADING_RE = /^##\s+(.+)$/;

export interface ExtractMeta {
  event_type: string;
  attributed_to: string;
  at: string;
}

/** P5.1 启发式提取：列表项与 ## 小节（跳过 摘要/正文）。 */
export function heuristicExtractFacts(body: string, meta: ExtractMeta): Fact[] {
  const texts = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    const listMatch = LIST_ITEM_RE.exec(line.trim());
    if (listMatch?.[1]) {
      const t = listMatch[1].trim();
      if (t) texts.add(t);
      continue;
    }
    const headingMatch = HEADING_RE.exec(line.trim());
    if (headingMatch?.[1]) {
      const h = headingMatch[1].trim();
      if (h && !SKIP_HEADINGS.has(h)) texts.add(h);
    }
  }

  return [...texts].map((text) => ({
    text,
    event_type: meta.event_type,
    attributed_to: meta.attributed_to,
    at: meta.at,
  }));
}

/** 校验待 append 的 facts（text 非空且 ≤2000）。 */
export function validateFactsForAppend(facts: Fact[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    if (!f.text?.trim()) {
      errors.push({ field: `facts[${i}].text`, message: "facts[].text 非空" });
    } else if (f.text.length > 2000) {
      errors.push({ field: `facts[${i}].text`, message: "facts[].text ≤2000" });
    }
  }
  return errors;
}
