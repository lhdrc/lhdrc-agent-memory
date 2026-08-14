import { appendFile } from "node:fs/promises";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { mkdirp } from "../util/fs.ts";
import { dirname } from "node:path";
import {
  extractFactsWithComplete,
  generateAbstractWithComplete,
  generateOverviewWithComplete,
  judgeDistillWithComplete,
  refineExperienceWithComplete,
} from "./distill-complete.ts";
import type {
  CompletePurpose,
  CompleteRequest,
  CompleteResult,
  DistillDecision,
  ExperienceContext,
  ExperienceResult,
  ExtractFact,
  FactExtractMeta,
  LLMProvider,
} from "./types.ts";

const PURPOSE_ENV: Record<CompletePurpose, string | undefined> = {
  compile: "DF_MEMORY_MOCK_COMPLETE_COMPILE",
  distill: "DF_MEMORY_MOCK_COMPLETE_DISTILL",
  extract: "DF_MEMORY_MOCK_COMPLETE_EXTRACT",
  abstract: "DF_MEMORY_MOCK_COMPLETE_ABSTRACT",
  other: undefined,
};

export function isEnvMockCompleteEnabled(): boolean {
  if (process.env.DF_MEMORY_MOCK_COMPLETE != null) return true;
  if (process.env.DF_MEMORY_MOCK_COMPLETE_FAIL === "1") return true;
  for (const key of Object.values(PURPOSE_ENV)) {
    if (key && process.env[key] != null) return true;
  }
  return false;
}

function mockCompleteText(purpose: CompletePurpose): string {
  const key = PURPOSE_ENV[purpose];
  if (key && process.env[key] != null) return process.env[key]!;
  return process.env.DF_MEMORY_MOCK_COMPLETE ?? "";
}

function distillJsonlLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));
}

/**
 * 测试注入：DF_MEMORY_MOCK_COMPLETE 提供 complete() 文本。
 * CLI 子进程无法 mock fetch，用环境变量走这条路径（P6.4 / P7.1）。
 */
export class EnvMockLLMProvider implements LLMProvider {
  readonly id = "openai";
  private distillSeq = 0;

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const log = process.env.DF_MEMORY_MOCK_COMPLETE_LOG;
    if (log) {
      await mkdirp(dirname(log));
      await appendFile(log, `${req.purpose}\n`, "utf8");
    }
    if (process.env.DF_MEMORY_MOCK_COMPLETE_FAIL === "1") {
      throw new MemoryError(ErrorCodes.LLM, "mock complete 失败");
    }
    let text = mockCompleteText(req.purpose);
    if (req.purpose === "distill") {
      const lines = distillJsonlLines(text);
      if (lines.length >= 2) {
        const i = Math.min(this.distillSeq, lines.length - 1);
        this.distillSeq += 1;
        text = lines[i]!;
      }
    }
    return { text, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }

  async judgeDistill(existing: string[], candidate: string): Promise<DistillDecision> {
    return judgeDistillWithComplete((req) => this.complete(req), existing, candidate);
  }

  async generateAbstract(content: string): Promise<string> {
    return generateAbstractWithComplete((req) => this.complete(req), content);
  }

  async generateOverview(children: string[]): Promise<string> {
    return generateOverviewWithComplete((req) => this.complete(req), children);
  }

  async refineExperience(ctx: ExperienceContext): Promise<ExperienceResult> {
    return refineExperienceWithComplete((req) => this.complete(req), ctx);
  }

  async extractFacts(body: string, meta: FactExtractMeta): Promise<ExtractFact[]> {
    return extractFactsWithComplete((req) => this.complete(req), body, meta);
  }
}
