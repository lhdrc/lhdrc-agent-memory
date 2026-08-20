import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** P10.1 / HaluMem publish：聊天 + embedding 默认（硅基流动兼容 API）。 */
export const CHAT_MODEL = process.env.DF_EVAL_CHAT_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Flash";
export const EMBED_MODEL = process.env.DF_EVAL_EMBED_MODEL?.trim() || "Qwen/Qwen3-Embedding-8B";
export const EMBED_DIMS = Number(process.env.DF_EVAL_EMBED_DIMS ?? 4096) || 4096;
export const API_BASE = (process.env.DF_EVAL_API_BASE?.trim() || "https://api.siliconflow.cn").replace(/\/+$/, "");

export function evalKeyEnv(): string {
  if (process.env.DF_EVAL_API_KEY?.trim()) return "DF_EVAL_API_KEY";
  if (process.env.SILICONFLOW_API_KEY?.trim()) return "SILICONFLOW_API_KEY";
  return "OPENAI_API_KEY";
}

export function hasEvalKey(envName: string): boolean {
  return Boolean(process.env[envName]?.trim());
}

export async function patchPublishYml(repoRoot: string, keyEnv: string): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  let yml = await readFile(path, "utf8");
  yml = yml.replace(/^llm:\n  provider: off/m, "llm:\n  provider: openai");
  yml = yml.replace(/^  model: gpt-4o-mini$/m, `  model: ${CHAT_MODEL}`);
  yml = yml.replace(/^  model: text-embedding-3-small$/m, `  model: ${EMBED_MODEL}`);
  yml = yml.replace(/^  dims: 1536$/m, `  dims: ${EMBED_DIMS}`);
  yml = yml.replace(/^  base_url: https:\/\/api\.openai\.com$/m, `  base_url: ${API_BASE}`);
  yml = yml.replace(/^  openai_api_key_env: OPENAI_API_KEY$/gm, `  openai_api_key_env: ${keyEnv}`);
  yml = yml.replace(/^  onnx_model_path: ""$/m, `  onnx_model_path: ""\n  base_url: ${API_BASE}`);
  yml = yml.replace(/^  distill: true$/m, "  distill: false");
  yml = yml.replace(/^    distill: false$/m, "    distill: true");
  yml = yml.replace(/^  lazy_min_sources: 5$/m, "  lazy_min_sources: 9999");
  yml = yml.replace(/^  auto_crystallize: true$/m, "  auto_crystallize: false");
  await writeFile(path, yml, "utf8");
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}
