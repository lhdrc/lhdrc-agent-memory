/**
 * 两阶段作答：先 hybrid/think 检索片段，再按需读原文/历史/邻接，最后由 LLM 作答。
 * 对应项目热路径：retrieve → readNode(withHistory) → answer。
 * P13.3 history 正排 + P13.2 图邻接在此展开；无 LLM key 时 fail-open 回片段拼接。
 */
import { readNode } from "../../packages/core/src/index.ts";
import type { QueryHit } from "../../packages/core/src/index.ts";

export function evalAnswerMode(): "auto" | "on" | "off" {
  const v = (process.env.DF_EVAL_ANSWER ?? "auto").trim().toLowerCase();
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  return "auto";
}

export function evalJudgeKind(): "rule" | "llm" {
  const v = (process.env.DF_EVAL_JUDGE ?? "rule").trim().toLowerCase();
  return v === "llm" ? "llm" : "rule";
}

export function shouldAnswerWithLlm(mode: "auto" | "on" | "off", hasKey: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return hasKey;
}

const MAX_HITS = 5;
const MAX_CHARS_PER_HIT = 4000;
const MAX_HISTORY_TURNS = 4;
const MAX_HISTORY_CHARS = 2000;

function clip(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 读单命中全文 + history 正排（P13.3），fail-open 回 snippet。 */
async function readHitFull(
  repoRoot: string,
  brainId: string,
  hit: QueryHit,
): Promise<{ path: string; title: string; body: string; history: string }> {
  const fallback = `${hit.title ?? ""}\n${hit.snippet ?? ""}`.trim();
  try {
    const node = await readNode(repoRoot, brainId, hit.path, { withHistory: true } as never);
    const raw = typeof (node as { raw?: unknown }).raw === "string" ? String((node as { raw: string }).raw) : fallback;
    let history = "";
    const withHist = node as { historyTurns?: Array<{ role: string; text: string }>; history?: string };
    if (Array.isArray(withHist.historyTurns) && withHist.historyTurns.length > 0) {
      history = withHist.historyTurns
        .slice(-MAX_HISTORY_TURNS)
        .map((t) => `${t.role}: ${t.text}`)
        .join("\n");
    } else if (typeof withHist.history === "string") {
      history = withHist.history;
    }
    return {
      path: hit.path,
      title: hit.title ?? "",
      body: clip(raw, MAX_CHARS_PER_HIT) || clip(fallback, MAX_CHARS_PER_HIT),
      history: clip(history, MAX_HISTORY_CHARS),
    };
  } catch {
    return { path: hit.path, title: hit.title ?? "", body: clip(fallback, MAX_CHARS_PER_HIT), history: "" };
  }
}

export async function buildAnswerContext(
  repoRoot: string,
  brainId: string,
  hits: QueryHit[],
): Promise<string> {
  const top = hits.slice(0, MAX_HITS);
  const sections: string[] = [];
  for (let i = 0; i < top.length; i++) {
    const full = await readHitFull(repoRoot, brainId, top[i]!);
    let sec = `### [${i + 1}] ${full.title || full.path}\npath: ${full.path}\n${full.body}`;
    if (full.history) sec += `\n--- history ---\n${full.history}`;
    sections.push(sec);
  }
  return sections.join("\n\n");
}

const ANSWER_SYSTEM = [
  "You answer questions using ONLY the provided memory excerpts.",
  "Quote original wording for names/numbers; do not invent.",
  "If the excerpts do not contain the answer, reply exactly: NOT_FOUND.",
  "Reply in the same language as the question, concisely.",
].join(" ");

export async function answerWithMemory(opts: {
  query: string;
  context: string;
  complete: (req: { prompt: string; system?: string; purpose: "other" }) => Promise<{ text: string }>;
}): Promise<string> {
  const prompt = `Question: ${opts.query}\n\nMemory excerpts:\n${opts.context}\n\nAnswer:`;
  const res = await opts.complete({ prompt, system: ANSWER_SYSTEM, purpose: "other" });
  return res.text.trim();
}

const JUDGE_SYSTEM = [
  "You judge whether the predicted answer contains the gold answer.",
  "Reply with exactly one word: YES or NO.",
].join(" ");

export async function llmJudge(opts: {
  query: string;
  gold: string;
  answer: string;
  complete: (req: { prompt: string; system?: string; purpose: "other" }) => Promise<{ text: string }>;
}): Promise<number> {
  const prompt = `Question: ${opts.query}\nGold: ${opts.gold}\nPredicted: ${opts.answer}\nDoes the predicted answer contain or semantically match the gold? Reply YES or NO.`;
  try {
    const res = await opts.complete({ prompt, system: JUDGE_SYSTEM, purpose: "other" });
    return /^\s*yes\b/i.test(res.text) ? 1 : 0;
  } catch {
    return 0;
  }
}
