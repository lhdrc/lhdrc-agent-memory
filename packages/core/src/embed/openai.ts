import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMS = 1536;

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly id = "openai";
  readonly dims: number;
  private readonly model: string;
  private readonly apiKeyEnv: string;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model || DEFAULT_MODEL;
    this.apiKeyEnv = cfg.openai_api_key_env || "OPENAI_API_KEY";
    this.dims = cfg.dims ?? DEFAULT_DIMS;
  }

  private resolveApiKey(): string {
    const key = process.env[this.apiKeyEnv]?.trim();
    if (!key) {
      throw new MemoryError(
        ErrorCodes.USAGE,
        `OpenAI embedding 需要环境变量 ${this.apiKeyEnv}`,
        { env: this.apiKeyEnv },
      );
    }
    return key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const apiKey = this.resolveApiKey();
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MemoryError(
        ErrorCodes.INDEX,
        `OpenAI embeddings API 失败: ${res.status} ${res.statusText}`,
        { status: res.status, body: body.slice(0, 500) },
      );
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    return json.data.map((d) => d.embedding);
  }
}
