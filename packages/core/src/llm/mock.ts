import { appendFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { mkdirp } from "../util/fs.ts";
import { dirname } from "node:path";
import type { CompleteRequest, CompleteResult, DistillDecision, ExperienceContext, ExperienceResult, LLMProvider } from "./types.ts";

/**
 * 测试注入：DF_MEMORY_MOCK_COMPLETE 提供 complete() 文本。
 * CLI 子进程无法 mock fetch，用环境变量走这条路径（P6.4）。
 */
export class EnvMockLLMProvider implements LLMProvider {
  readonly id = "openai";

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const log = process.env.DF_MEMORY_MOCK_COMPLETE_LOG;
    if (log) {
      await mkdirp(dirname(log));
      await appendFile(log, `${req.purpose}\n`, "utf8");
    }
    if (process.env.DF_MEMORY_MOCK_COMPLETE_FAIL === "1") {
      throw new MemoryError(ErrorCodes.LLM, "mock complete 失败");
    }
    const text = process.env.DF_MEMORY_MOCK_COMPLETE ?? "";
    return { text, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }

  async judgeDistill(_existing: string[], _candidate: string): Promise<DistillDecision> {
    return { candidate: "skip", confidence: 0, rationale: "mock" };
  }

  async generateAbstract(content: string): Promise<string> {
    return content.slice(0, 100);
  }

  async generateOverview(children: string[]): Promise<string> {
    return children.join("\n").slice(0, 200);
  }

  async refineExperience(_ctx: ExperienceContext): Promise<ExperienceResult> {
    throw new MemoryError(ErrorCodes.DISABLED, "mock refineExperience unavailable");
  }
}
