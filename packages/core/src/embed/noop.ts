import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingProvider } from "./types.ts";

export class NoopEmbedding implements EmbeddingProvider {
  readonly id = "off";
  readonly dims = 0;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new MemoryError(
      ErrorCodes.DISABLED,
      "embedding provider 已关闭（embedding.provider=off）；语义检索不可用",
    );
  }
}
