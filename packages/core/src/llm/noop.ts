import type { DistillDecision, ExperienceContext, ExperienceResult, LLMProvider } from "./types.ts";

/** provider=off：所有 LLM 调用返回空/跳过决策。 */
export class NoopLLMProvider implements LLMProvider {
  readonly id = "off";

  async judgeDistill(_existing: string[], _candidate: string): Promise<DistillDecision> {
    return { candidate: "skip", confidence: 0, rationale: "llm off" };
  }

  async generateAbstract(content: string): Promise<string> {
    return content.replace(/\s+/g, " ").trim().slice(0, 100);
  }

  async generateOverview(children: string[]): Promise<string> {
    return children.join("\n").slice(0, 200);
  }

  async refineExperience(_ctx: ExperienceContext): Promise<ExperienceResult> {
    throw new Error("NoopLLMProvider.refineExperience unavailable when provider=off");
  }
}
