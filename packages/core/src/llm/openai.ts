import { MemoryError, ErrorCodes } from "../errors.ts";
import { appendCostEntry, wouldExceedCap, type CostConfig } from "../cost/logger.ts";
import {
  extractFactsWithComplete,
  generateAbstractWithComplete,
  generateOverviewWithComplete,
  judgeDistillWithComplete,
  refineExperienceWithComplete,
} from "./distill-complete.ts";
import {
  DEFAULT_LLM_CONFIG,
  type CompleteRequest,
  type CompleteResult,
  type DistillDecision,
  type ExperienceContext,
  type ExperienceResult,
  type ExtractFact,
  type FactExtractMeta,
  type LLMConfig,
  type LLMProvider,
} from "./types.ts";

const COMPLETE_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4096;

export interface OpenAILLMOptions {
  repoRoot?: string;
  cost?: CostConfig;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class OpenAILLMProvider implements LLMProvider {
  readonly id = "openai";
  private readonly cfg: LLMConfig;
  private readonly opts: OpenAILLMOptions;

  constructor(cfg: LLMConfig, opts: OpenAILLMOptions = {}) {
    this.cfg = cfg;
    this.opts = opts;
  }

  private resolveApiKey(): string {
    const envName = this.cfg.openai_api_key_env || DEFAULT_LLM_CONFIG.openai_api_key_env;
    const key = process.env[envName]?.trim();
    if (!key) {
      throw new MemoryError(ErrorCodes.DISABLED, `llm.provider=openai 缺少环境变量 ${envName}`, {
        skipped_reason: "missing_key",
        env: envName,
      });
    }
    return key;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (
      (req.purpose === "compile" && this.cfg.kill_switch.compile) ||
      (req.purpose === "distill" && this.cfg.kill_switch.distill) ||
      (req.purpose === "extract" && this.cfg.kill_switch.extract) ||
      (req.purpose === "abstract" && this.cfg.kill_switch.abstract)
    ) {
      throw new MemoryError(ErrorCodes.DISABLED, `llm.kill_switch.${req.purpose}=true`, {
        skipped_reason: "kill_switch",
      });
    }
    const repoRoot = this.opts.repoRoot;
    const cost = this.opts.cost;
    if (repoRoot && cost && (await wouldExceedCap(repoRoot, cost))) {
      await appendCostEntry(repoRoot, cost, {
        kind: req.purpose,
        tokens_in: 0,
        tokens_out: 0,
        model: this.cfg.model || DEFAULT_LLM_CONFIG.model,
        skipped: true,
        reason: "daily_token_cap",
      });
      throw new MemoryError(ErrorCodes.DISABLED, "daily token cap exceeded", {
        skipped_reason: "cost_cap",
      });
    }

    const apiKey = this.resolveApiKey();
    const base = (this.cfg.base_url || DEFAULT_LLM_CONFIG.base_url).replace(/\/+$/, "");
    const url = `${base}/v1/chat/completions`;
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const doFetch = this.opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.cfg.model || DEFAULT_LLM_CONFIG.model,
          temperature: 0,
          max_tokens: MAX_TOKENS,
          messages,
        }),
        signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new MemoryError(ErrorCodes.LLM, `OpenAI complete 请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MemoryError(ErrorCodes.LLM, `OpenAI complete HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body: body.slice(0, 500),
      });
    }

    let json: ChatCompletionsResponse;
    try {
      json = (await res.json()) as ChatCompletionsResponse;
    } catch (e) {
      throw new MemoryError(ErrorCodes.LLM, `OpenAI complete 响应不是 JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!json.choices?.length || !text) {
      throw new MemoryError(ErrorCodes.LLM, "OpenAI complete 返回空 choices");
    }

    const usage = json.usage
      ? {
          prompt_tokens: Number(json.usage.prompt_tokens ?? 0) || 0,
          completion_tokens: Number(json.usage.completion_tokens ?? 0) || 0,
        }
      : undefined;

    if (repoRoot && cost) {
      await appendCostEntry(repoRoot, cost, {
        kind: req.purpose === "compile" ? "compile" : req.purpose,
        tokens_in: usage?.prompt_tokens ?? 0,
        tokens_out: usage?.completion_tokens ?? 0,
        model: json.model || this.cfg.model || DEFAULT_LLM_CONFIG.model,
      });
    }

    return { text, usage };
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
