import { MemoryError, ErrorCodes } from "../errors.ts";
import { LocalHashEmbedding } from "./local.ts";
import { NoopEmbedding } from "./noop.ts";
import { OpenAIEmbedding } from "./openai.ts";
import { OnnxEmbedding, onnxWeightsPresent } from "./onnx.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";

const LOCAL_DEFAULT_DIMS = 384;

export interface ResolveEmbedderResult {
  embedder: EmbeddingProvider;
  fallback: boolean;
}

export interface ResolveEmbedderOptions {
  /** true：缺 key / 缺 onnx 权重抛 E_DISABLED（rebuild --embeddings） */
  strict?: boolean;
}

export function hasOpenAiEmbedKey(cfg: EmbeddingConfig): boolean {
  const env = cfg.openai_api_key_env || "OPENAI_API_KEY";
  return Boolean(process.env[env]?.trim());
}

function hashFallback(cfg: EmbeddingConfig, from: string): LocalHashEmbedding {
  return new LocalHashEmbedding(cfg.dims ?? LOCAL_DEFAULT_DIMS, from);
}

/**
 * P9.2：读/写热路径同一 resolve。openai 缺 key、onnx 缺文件 → 哈希 + fallback。
 * 未知 provider → E_USAGE。strict 时缺依赖 → E_DISABLED（禁止把哈希写入声称 openai/onnx 的索引）。
 */
export function resolveEmbedder(
  cfg: EmbeddingConfig,
  opts?: ResolveEmbedderOptions,
): ResolveEmbedderResult {
  switch (cfg.provider) {
    case "off":
      return { embedder: new NoopEmbedding(), fallback: false };
    case "local":
      return { embedder: new LocalHashEmbedding(cfg.dims ?? LOCAL_DEFAULT_DIMS), fallback: false };
    case "onnx": {
      if (onnxWeightsPresent(cfg)) {
        return { embedder: new OnnxEmbedding(cfg), fallback: false };
      }
      if (opts?.strict) {
        throw new MemoryError(
          ErrorCodes.DISABLED,
          cfg.onnx_model_path?.trim()
            ? `onnx 权重不存在: ${cfg.onnx_model_path}`
            : "embedding.provider=onnx 需要 onnx_model_path",
        );
      }
      return { embedder: hashFallback(cfg, "onnx"), fallback: true };
    }
    case "openai": {
      if (hasOpenAiEmbedKey(cfg)) {
        return { embedder: new OpenAIEmbedding(cfg), fallback: false };
      }
      if (opts?.strict) {
        throw new MemoryError(
          ErrorCodes.DISABLED,
          `OpenAI embedding 需要环境变量 ${cfg.openai_api_key_env || "OPENAI_API_KEY"}`,
        );
      }
      return { embedder: hashFallback(cfg, "openai"), fallback: true };
    }
    default:
      throw new MemoryError(
        ErrorCodes.USAGE,
        `未知 embedding.provider: ${String((cfg as EmbeddingConfig).provider)}`,
      );
  }
}

export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  opts?: ResolveEmbedderOptions,
): EmbeddingProvider {
  return resolveEmbedder(cfg, opts).embedder;
}
