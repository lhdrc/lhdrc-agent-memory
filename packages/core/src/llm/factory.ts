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
