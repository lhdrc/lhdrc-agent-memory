export type RecallCommand = "think" | "find";

export type QueryGateHit = {
  query: string;
  command: RecallCommand;
};

export type QueryGateCtx = {
  sessionStart?: boolean;
  bypass?: boolean;
  force?: boolean;
  failCount?: number;
  lastQuery?: string;
  lastQueryAtMs?: number;
  lastInjectedQuery?: string;
  nowMs?: number;
  threshold?: number;
  min_query_chars?: number;
  dedupe_window_s?: number;
};

const HISTORY = ["以前", "上次", "谁决定", "踩过", "我们约定", "last time", "how did we"];
const CONVENTION = ["依赖", "目录结构", "错误码", "鉴权", "公共 api", "memory.yml", "errorcodes"];
const OPERATIONAL = ["实现", "修复", "重构", "部署", "写入", "create", "implement", "fix", "deploy", "build"];
const EXECUTE = ["测试", "构建", "调试", "test", "build", "debug", "run"];
const FAILURE = ["报错", "失败", "异常", "timeout", "exception", "error", "e_"];
const ENGINEERING = ["errorcodes", "hook", "api", "pack", "memory.yml"];
const EXPERIENCE = ["踩坑", "教训", "best practice", "avoid"];
const CONVERSATIONAL = ["你好", "谢谢", "好的", "ok", "继续", "再试", "修一下", "lint 一下", "翻译", "总结这段"];

function unicodeLen(s: string): number {
  return [...s].length;
}

function hasAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

function firstHit(text: string, words: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0) return text.slice(i, i + w.length);
  }
  return undefined;
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w) out.add(w);
  }
  return out;
}

function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function looksLikePath(text: string): boolean {
  return /(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+/.test(text) || /\.[a-z]{1,8}\b/i.test(text);
}

function extractMemoryQuery(userText: string): string | null {
  const slash = userText.match(/^\/memory(?:\s+(.+))?$/i);
  if (slash) return (slash[1] ?? userText).trim() || userText;
  const zh = userText.match(/^查一下记忆(?:[：:\s]+(.+))?$/);
  if (zh) return (zh[1] ?? userText).trim() || userText;
  if (userText.includes("查一下记忆")) return userText;
  return null;
}

export type ShouldQueryMemoryInput = {
  userText: string;
  ctx?: QueryGateCtx;
};

/**
 * P6.5 查询门控：词表 + 打分，不调 LLM。
 */
export function shouldQueryMemory(input: ShouldQueryMemoryInput): QueryGateHit | null {
  const ctx = input.ctx ?? {};
  const userText = input.userText ?? "";
  const trimmed = userText.trim();
  const now = ctx.nowMs ?? Date.now();
  const minChars = ctx.min_query_chars ?? 4;
  const threshold = ctx.threshold ?? 3;
  const windowMs = (ctx.dedupe_window_s ?? 120) * 1000;

  if (ctx.bypass) return null;
  if (!trimmed || unicodeLen(trimmed) < minChars) return null;
  if (trimmed.includes("<df-memory-context")) return null;
  if (ctx.lastQuery !== undefined && ctx.lastQuery === trimmed && ctx.lastQueryAtMs != null && now - ctx.lastQueryAtMs < windowMs) {
    return null;
  }

  if (ctx.sessionStart || ctx.force) {
    return { query: trimmed, command: "think" };
  }

  const forcedQ = extractMemoryQuery(trimmed);
  if (forcedQ !== null && (/^\/memory/i.test(trimmed) || trimmed.includes("查一下记忆"))) {
    return { query: forcedQ, command: "find" };
  }

  let score = 0;
  let operational = false;
  let query = trimmed;

  if (hasAny(trimmed, HISTORY)) score += 3;
  const convHit = firstHit(trimmed.toLowerCase(), CONVENTION);
  if (hasAny(trimmed, CONVENTION)) {
    score += 3;
    if (convHit) {
      const orig = trimmed.match(new RegExp(convHit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      if (orig) query = orig[0]!;
    }
  }
  if (hasAny(trimmed, OPERATIONAL)) {
    score += 3;
    operational = true;
  }
  if (hasAny(trimmed, EXECUTE)) score += 2;
  if (hasAny(trimmed, FAILURE) && (ctx.failCount ?? 0) >= 2) {
    score += 2;
    operational = true;
  }
  if (hasAny(trimmed, ENGINEERING) || looksLikePath(trimmed)) score += 2;
  if (hasAny(trimmed, EXPERIENCE)) score += 1;
  if (hasAny(trimmed, CONVERSATIONAL)) score -= 3;

  const knowledge = /什么是|what is|what's/i.test(trimmed);
  const hasVerb = hasAny(trimmed, OPERATIONAL) || hasAny(trimmed, EXECUTE);
  const hasEng = hasAny(trimmed, ENGINEERING) || hasAny(trimmed, CONVENTION) || looksLikePath(trimmed);
  if (knowledge && !hasVerb && !hasEng) score -= 2;

  if (ctx.lastInjectedQuery && ctx.lastQueryAtMs != null && now - ctx.lastQueryAtMs < windowMs) {
    if (jaccard(trimmed, ctx.lastInjectedQuery) >= 0.5) score -= 3;
  }

  if (score < threshold) return null;
  const command: RecallCommand = operational || ctx.sessionStart || (ctx.failCount ?? 0) >= 2 ? "think" : "find";
  return { query, command };
}
