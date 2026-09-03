import { MemoryError, ErrorCodes } from "../errors.ts";
import { appendCostEntry, wouldExceedCap, type CostConfig } from "../cost/logger.ts";
import {
  extractFactsWithComplete,
  generateAbstractWithComplete,
  generateOverviewWithComplete,
  judgeDistillWithComplete,
  refineExperienceWithComplete,
} from "./distill-complete.ts";
import { DEFAULT_LLM_CONFIG, type CompleteRequest, type CompleteResult, type DistillDecision, type ExperienceContext, type ExperienceResult, type ExtractFact, type FactExtractMeta, type LLMConfig, type LLMProvider } from "./types.ts";
import { openaiCompatUrl, zenResponsesUrl } from "../util/openai-compat-url.ts";

const COMPLETE_TIMEOUT_MS = 120_000;
/** 推理模型（如 hy3-free）会先占 reasoning_content，需留足 completion 额度。 */
const MAX_TOKENS = 8192;

export interface OpenAILLMOptions {
  repoRoot?: string;
  cost?: CostConfig;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface ResponsesApiContent {
  type?: string;
  text?: string;
}

interface ResponsesApiOutput {
  type?: string;
  status?: string;
  role?: string;
  content?: ResponsesApiContent[];
}

interface ResponsesApiResponse {
  status?: string;
  model?: string;
  output?: ResponsesApiOutput[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: unknown;
}

function pickMessageText(msg?: {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
} | null): string {
  if (!msg) return "";
  const content = typeof msg.content === "string" ? msg.content.trim() : "";
  if (content) return content;
  const reasoning =
    (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "") ||
    (typeof msg.reasoning === "string" ? msg.reasoning : "");
  return reasoning.trim();
}

/** OpenCode Go / 部分推理模型：顶层 reasoning_effort（勿同时传 thinking）。 */
function reasoningEffortBody(): Record<string, string> {
  const raw =
    process.env.DF_MEMORY_REASONING_EFFORT?.trim() ||
    process.env.DF_EVAL_LLM_REASONING_EFFORT?.trim() ||
    "";
  const effort = raw.toLowerCase();
  if (!effort) return {};
  if (!["minimal", "low", "medium", "high", "max"].includes(effort)) return {};
  return { reasoning_effort: effort };
}

/** Responses API 用 reasoning 对象；muse-spark 在 high 下易把 token 花在推理上，默认 minimal。 */
function responsesReasoningBody(): { reasoning: { effort: string } } {
  const raw =
    process.env.DF_MEMORY_REASONING_EFFORT?.trim() ||
    process.env.DF_EVAL_LLM_REASONING_EFFORT?.trim() ||
    "minimal";
  const effort = raw.toLowerCase();
  const allowed = ["minimal", "low", "medium", "high", "max"];
  return { reasoning: { effort: allowed.includes(effort) ? effort : "minimal" } };
}

/** muse-spark 系列走 Zen Responses API（chat/completions 会 401/500）。 */
function usesResponsesApi(model: string): boolean {
  return /muse-spark/i.test(model);
}

function pickResponsesText(json: ResponsesApiResponse): string {
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  const out = Array.isArray(json.output) ? json.output : [];
  const parts: string[] = [];
  for (const item of out) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
        parts.push(c.text);
      }
    }
  }
  return parts.join("").trim();
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
    const model = this.cfg.model || DEFAULT_LLM_CONFIG.model;
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    if (usesResponsesApi(model)) {
      return this.completeViaResponses(req, { apiKey, model, doFetch, repoRoot, cost });
    }
    const url = openaiCompatUrl(this.cfg.base_url || DEFAULT_LLM_CONFIG.base_url, "chat/completions");
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

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
          ...reasoningEffortBody(),
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

    const text = pickMessageText(json.choices?.[0]?.message);
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

  /** Zen Responses API（muse-spark 等）：`POST /v1/responses` + `{model, instructions?, input}`。 */
  private async completeViaResponses(
    req: CompleteRequest,
    ctx: {
      apiKey: string;
      model: string;
      doFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
      repoRoot?: string;
      cost?: import("../cost/logger.ts").CostConfig;
    },
  ): Promise<CompleteResult> {
    const url = zenResponsesUrl(this.cfg.base_url || "https://opencode.ai/zen");
    let res: Response;
    try {
      res = await ctx.doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ctx.model,
          ...(req.system ? { instructions: req.system } : {}),
          input: req.prompt,
          max_output_tokens: MAX_TOKENS,
          ...responsesReasoningBody(),
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
    let json: ResponsesApiResponse;
    try {
      json = (await res.json()) as ResponsesApiResponse;
    } catch (e) {
      throw new MemoryError(ErrorCodes.LLM, `OpenAI complete 响应不是 JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = pickResponsesText(json);
    if (!text) {
      throw new MemoryError(ErrorCodes.LLM, "OpenAI complete 返回空 output");
    }
    const usage = json.usage
      ? {
          prompt_tokens: Number(json.usage.input_tokens ?? 0) || 0,
          completion_tokens: Number(json.usage.output_tokens ?? 0) || 0,
        }
      : undefined;
    if (ctx.repoRoot && ctx.cost) {
      await appendCostEntry(ctx.repoRoot, ctx.cost, {
        kind: req.purpose === "compile" ? "compile" : req.purpose,
        tokens_in: usage?.prompt_tokens ?? 0,
        tokens_out: usage?.completion_tokens ?? 0,
        model: json.model || ctx.model,
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
