import { MemoryError, ErrorCodes } from "../errors.ts";
import type {
  CompleteRequest,
  CompleteResult,
  DistillDecision,
  ExperienceContext,
  ExperienceResult,
  LLMProvider,
} from "./types.ts";

/** provider=off：complete 不可用；其余方法返回空/跳过决策。 */
export class NoopLLMProvider implements LLMProvider {
  readonly id = "off";

  async complete(_req: CompleteRequest): Promise<CompleteResult> {
    throw new MemoryError(ErrorCodes.DISABLED, "llm.provider=off：complete 不可用（会话摄入需要 openai + key 或测试 mock）", {
      skipped_reason: "provider_off",
    });
  }

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
