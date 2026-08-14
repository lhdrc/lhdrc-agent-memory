/**
 * OpenAI / EnvMock 共用：既有 LLM 方法经 complete()。
 */
import type {
  CompleteRequest,
  CompleteResult,
  DistillDecision,
  ExperienceContext,
  ExperienceResult,
  ExtractFact,
  FactExtractMeta,
} from "./types.ts";
import {
  EXTRACT_JSON_REPAIR_SUFFIX,
  formatExtractUserPrompt,
  formatJudgeUserPrompt,
  formatRefineUserPrompt,
  JUDGE_JSON_REPAIR_SUFFIX,
  loadAbstractPrompt,
  loadDistillJudgePrompt,
  loadDistillRefinePrompt,
  loadExtractPrompt,
  loadOverviewPrompt,
  REFINE_JSON_REPAIR_SUFFIX,
} from "./distill-prompt.ts";
import {
  isExtractJsonFailure,
  isJudgeJsonFailure,
  parseExperienceResult,
  parseExtractFacts,
  parseJudgeDecision,
  stripMarkdownFence,
} from "./parse-complete.ts";

type CompleteFn = (req: CompleteRequest) => Promise<CompleteResult>;

export async function judgeDistillWithComplete(
  complete: CompleteFn,
  existing: string[],
  candidate: string,
): Promise<DistillDecision> {
  const system = await loadDistillJudgePrompt();
  const prompt = formatJudgeUserPrompt(existing, candidate);
  const first = await complete({ purpose: "distill", system, prompt });
  if (isJudgeJsonFailure(first.text)) {
    const repaired = await complete({
      purpose: "distill",
      system,
      prompt: `${prompt}\n\n${JUDGE_JSON_REPAIR_SUFFIX}`,
    });
    return parseJudgeDecision(repaired.text);
  }
  return parseJudgeDecision(first.text);
}

export async function refineExperienceWithComplete(
  complete: CompleteFn,
  ctx: ExperienceContext,
): Promise<ExperienceResult> {
  const system = await loadDistillRefinePrompt();
  const prompt = formatRefineUserPrompt(ctx);
  const first = await complete({ purpose: "distill", system, prompt });
  try {
    return parseExperienceResult(first.text);
  } catch {
    const repaired = await complete({
      purpose: "distill",
      system,
      prompt: `${prompt}\n\n${REFINE_JSON_REPAIR_SUFFIX}`,
    });
    return parseExperienceResult(repaired.text);
  }
}

export async function extractFactsWithComplete(
  complete: CompleteFn,
  body: string,
  meta: FactExtractMeta,
): Promise<ExtractFact[]> {
  const system = await loadExtractPrompt();
  const prompt = formatExtractUserPrompt(body, meta);
  const first = await complete({ purpose: "extract", system, prompt });
  if (!isExtractJsonFailure(first.text)) {
    return parseExtractFacts(first.text, meta);
  }
  const repaired = await complete({
    purpose: "extract",
    system,
    prompt: `${prompt}\n\n${EXTRACT_JSON_REPAIR_SUFFIX}`,
  });
  if (isExtractJsonFailure(repaired.text)) return [];
  return parseExtractFacts(repaired.text, meta);
}

export async function generateAbstractWithComplete(complete: CompleteFn, content: string): Promise<string> {
  const system = await loadAbstractPrompt();
  const { text } = await complete({ purpose: "abstract", system, prompt: content });
  return stripMarkdownFence(text).trim();
}

export async function generateOverviewWithComplete(complete: CompleteFn, children: string[]): Promise<string> {
  const system = await loadOverviewPrompt();
  const { text } = await complete({ purpose: "abstract", system, prompt: children.join("\n\n") });
  return stripMarkdownFence(text).trim();
}
