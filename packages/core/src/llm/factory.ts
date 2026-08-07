import type { LLMConfig, LLMProvider } from "./types.ts";
import { NoopLLMProvider } from "./noop.ts";

export function createLLMProvider(cfg: LLMConfig): LLMProvider {
  if (cfg.provider === "off") return new NoopLLMProvider();
  // P2.2 foundation: only off stub; real providers in later phases
  return new NoopLLMProvider();
}

export function isDistillEnabled(cfg: LLMConfig): boolean {
  if (cfg.provider === "off") return false;
  if (cfg.kill_switch.distill) return false;
  return cfg.distill;
}
