import { sha256Hex } from "../../packages/core/src/index.ts";

/** LoCoMo J-score 答题器。改字即新口径（P10.1）。 */
export const LOCOMO_ANSWER_SYSTEM = `You answer a question using only the retrieved memories from a knowledge base.
Do not use information that is not in the memories. If the memories are insufficient, say you don't know.
Reply with the answer only — no preamble, no citation list.`;

export const LOCOMO_ANSWER_USER = `Question:
{question}

Retrieved memories:
{memories}

Answer:`;

/** LoCoMo J-score judge。二进制 CORRECT/WRONG；不见 evidence dialog id。 */
export const LOCOMO_JUDGE_SYSTEM = `You evaluate whether a predicted answer is semantically the same as the gold answer for a conversational-memory QA item.
Reply with exactly one word: CORRECT or WRONG.

Mark CORRECT when the predicted answer captures the same core fact, entity, or conclusion as the gold answer. Paraphrase, extra harmless detail, or different wording is still CORRECT.
Mark WRONG when the predicted answer contradicts gold, names a different entity/event, or is empty / "I don't know" while gold is a specific fact.
Do not use outside knowledge. Do not explain.`;

export const LOCOMO_JUDGE_USER = `Question: {question}
Gold answer: {gold}
Predicted answer: {predicted}

Verdict:`;

export function locomoPromptHash(): { answer: string; judge: string } {
  return {
    answer: sha256Hex(`${LOCOMO_ANSWER_SYSTEM}\n${LOCOMO_ANSWER_USER}`),
    judge: sha256Hex(`${LOCOMO_JUDGE_SYSTEM}\n${LOCOMO_JUDGE_USER}`),
  };
}

export function formatAnswerPrompt(question: string, memories: string): { system: string; prompt: string } {
  return {
    system: LOCOMO_ANSWER_SYSTEM,
    prompt: LOCOMO_ANSWER_USER.replace("{question}", question).replace("{memories}", memories),
  };
}

export function formatJudgePrompt(
  question: string,
  gold: string,
  predicted: string,
): { system: string; prompt: string } {
  return {
    system: LOCOMO_JUDGE_SYSTEM,
    prompt: LOCOMO_JUDGE_USER.replace("{question}", question)
      .replace("{gold}", gold)
      .replace("{predicted}", predicted),
  };
}

/** CORRECT and not WRONG → 1; JSON verdict field; else WRONG (parse fail = 0). */
export function parseJudgeVerdict(text: string): "CORRECT" | "WRONG" {
  const raw = String(text ?? "").trim();
  if (!raw) return "WRONG";
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = String(j.verdict ?? j.label ?? j.judgment ?? j.score ?? "").toUpperCase();
    if (v === "CORRECT" || v === "1" || v === "TRUE") return "CORRECT";
    if (v === "WRONG" || v === "0" || v === "FALSE") return "WRONG";
  } catch {
    /* fall through */
  }
  const u = raw.toUpperCase();
  const hasC = /\bCORRECT\b/.test(u);
  const hasW = /\bWRONG\b/.test(u);
  if (hasC && !hasW) return "CORRECT";
  return "WRONG";
}
