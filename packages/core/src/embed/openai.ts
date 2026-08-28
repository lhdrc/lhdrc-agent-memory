import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";
import { fetchEmbedWithRetry, type EmbedFetch } from "./retry.ts";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMS = 1536;
const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export interface OpenAIEmbeddingOptions {
  fetch?: EmbedFetch;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly id = "openai";
  readonly dims: number;
  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: EmbedFetch;
  private readonly sleepFn?: (ms: number) => Promise<void>;

  constructor(cfg: EmbeddingConfig, opts: OpenAIEmbeddingOptions = {}) {
    this.model = cfg.model || DEFAULT_MODEL;
    this.apiKeyEnv = cfg.openai_api_key_env || "OPENAI_API_KEY";
    this.dims = cfg.dims ?? DEFAULT_DIMS;
    this.baseUrl = (cfg.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch;
    this.sleepFn = opts.sleep;
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
    const url = `${this.baseUrl}/v1/embeddings`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    };
    const res = await fetchEmbedWithRetry({
      url,
      init,
      fetch: this.fetchFn,
      sleep: this.sleepFn,
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
