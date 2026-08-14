/**
 * OpenAI / EnvMock 共用：judgeDistill / refineExperience 经 complete()。
 */
import type { CompleteRequest, CompleteResult, DistillDecision, ExperienceContext, ExperienceResult } from "./types.ts";
import {
  formatJudgeUserPrompt,
  formatRefineUserPrompt,
  JUDGE_JSON_REPAIR_SUFFIX,
  loadDistillJudgePrompt,
  loadDistillRefinePrompt,
  REFINE_JSON_REPAIR_SUFFIX,
} from "./distill-prompt.ts";
import { isJudgeJsonFailure, parseExperienceResult, parseJudgeDecision } from "./parse-complete.ts";

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
