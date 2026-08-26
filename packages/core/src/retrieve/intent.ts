/**
 * P3.1 意图分类（零 LLM）：schema pack intent_lexicon + 内置。
 * 权威：specs/三期/P3.1-graph-signals.md §7
 */

export type QueryIntent = "task" | "experience" | "person" | "relation" | "general";

export type ScopeRoute =
  | { kind: "prefix"; prefix: string; label: string }
  | { kind: "contains"; needle: string; label: string }
  | { kind: "off"; label: "off" };

/** P11.1：意图 → 搜前目录先验。relation/general 无收缩。 */
export function scopePrefixForIntent(intent: QueryIntent): ScopeRoute {
  switch (intent) {
    case "experience":
      return { kind: "prefix", prefix: "experiences/", label: "experiences/" };
    case "person":
      return { kind: "prefix", prefix: "entities/", label: "entities/" };
    case "task":
      return { kind: "contains", needle: "/issues/", label: "issues/" };
    default:
      return { kind: "off", label: "off" };
  }
}

const BUILTIN: Record<Exclude<QueryIntent, "general">, string[]> = {
  task: ["issue", "工单", "需求", "bug", "任务"],
  experience: ["经验", "lesson", "踩坑", "experience"],
  person: ["谁", "@", "负责人", "人员"],
  relation: ["的", "references", "提到", "提到了", "负责", "属于", "产出", "决定"],
};

const RELATION_TEMPLATES = [
  /谁\s*(负责|提到|提及)/,
  /(.+?)\s*的\s*(负责人|依赖|引用)/,
  /\breferences\b/i,
  /提到了/,
];

export function classifyIntent(
  query: string,
  intentLexicon?: Record<string, string[]> | null,
): QueryIntent {
  const q = query.trim();
  if (!q) return "general";

  for (const re of RELATION_TEMPLATES) {
    if (re.test(q)) return "relation";
  }

  const lexicon: Record<string, string[]> = {
    ...BUILTIN,
    ...(intentLexicon ?? {}),
  };

  // person / experience / task 按词表命中；先匹配更具体的
  const order: Array<Exclude<QueryIntent, "general" | "relation">> = ["person", "experience", "task"];
  const lower = q.toLowerCase();
  for (const intent of order) {
    const words = lexicon[intent] ?? BUILTIN[intent];
    for (const w of words) {
      if (!w) continue;
      if (w === "@") {
        if (/@[a-zA-Z0-9_-]+/.test(q)) return intent;
        continue;
      }
      if (lower.includes(w.toLowerCase())) return intent;
    }
  }

  // 「X 的 Y」类关系（短查询）
  if (/^.+的.+$/.test(q) && q.length <= 40) return "relation";

  return "general";
}
