import { MemoryError, ErrorCodes } from "../errors.ts";
import { OnnxLocalEmbedding } from "./local.ts";
import { NoopEmbedding } from "./noop.ts";
import { OpenAIEmbedding } from "./openai.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";

const LOCAL_DEFAULT_DIMS = 384;

export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  switch (cfg.provider) {
    case "off":
      return new NoopEmbedding();
    case "local":
      return new OnnxLocalEmbedding(cfg.dims ?? LOCAL_DEFAULT_DIMS);
    case "openai":
      return new OpenAIEmbedding(cfg);
    default:
      throw new MemoryError(
        ErrorCodes.USAGE,
        `未知 embedding.provider: ${String(cfg.provider)}`,
      );
  }
}
