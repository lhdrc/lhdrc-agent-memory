import { MemoryError, ErrorCodes } from "../errors.ts";
import type { CostConfig } from "../cost/logger.ts";
import { EnvMockLLMProvider, isEnvMockCompleteEnabled } from "./mock.ts";
import { NoopLLMProvider } from "./noop.ts";
import { OpenAILLMProvider, type OpenAILLMOptions } from "./openai.ts";
import { DEFAULT_LLM_CONFIG, type LLMConfig, type LLMProvider } from "./types.ts";

export type CreateLLMOptions = OpenAILLMOptions & {
  cost?: CostConfig;
};

function withDefaults(cfg: Partial<LLMConfig> & { provider: LLMConfig["provider"] }): LLMConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    ...cfg,
    kill_switch: {
      ...DEFAULT_LLM_CONFIG.kill_switch,
      ...(cfg.kill_switch ?? {}),
    },
  };
}

export function createLLMProvider(
  cfg: Partial<LLMConfig> & { provider: LLMConfig["provider"] },
  opts: CreateLLMOptions = {},
): LLMProvider {
  if (cfg.provider === "off") return new NoopLLMProvider();
  const full = withDefaults(cfg);
  if (isEnvMockCompleteEnabled()) {
    return new EnvMockLLMProvider();
  }
  return new OpenAILLMProvider(full, opts);
}

export function isDistillEnabled(cfg: LLMConfig): boolean {
  if (cfg.provider === "off") return false;
  if (cfg.kill_switch.distill) return false;
  return cfg.distill;
}

export function isCompileEnabled(cfg: LLMConfig): boolean {
  if (cfg.provider === "off") return false;
  if (cfg.kill_switch.compile) return false;
  return true;
}

export function hasLlmApiKey(cfg: LLMConfig): boolean {
  const env = cfg.openai_api_key_env || "OPENAI_API_KEY";
  return Boolean(process.env[env]?.trim());
}

/** P12.2：remember / compile 入队前预检；mock 测例放行。`--buffer` 攒窗不调用。 */
export function assertRememberCompileReady(cfg: LLMConfig, noExtract: boolean): void {
  if (noExtract) return;
  if (cfg.provider === "off") {
    throw new MemoryError(
      ErrorCodes.DISABLED,
      "llm.provider=off：complete 不可用（会话摄入需要 openai + key 或测试 mock）",
    );
  }
  if (cfg.kill_switch.compile) {
    throw new MemoryError(
      ErrorCodes.DISABLED,
      "kill_switch.compile=true：complete(purpose=compile) 已关闭",
    );
  }
  if (isEnvMockCompleteEnabled()) return;
  if (!hasLlmApiKey(cfg)) {
    throw new MemoryError(
      ErrorCodes.DISABLED,
      `OpenAI LLM 需要环境变量 ${cfg.openai_api_key_env || "OPENAI_API_KEY"}`,
    );
  }
}
