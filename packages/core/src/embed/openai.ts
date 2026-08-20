import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMS = 1536;
const DEFAULT_BASE = "https://api.openai.com";

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly id = "openai";
  readonly dims: number;
  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly baseUrl: string;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model || DEFAULT_MODEL;
    this.apiKeyEnv = cfg.openai_api_key_env || "OPENAI_API_KEY";
    this.dims = cfg.dims ?? DEFAULT_DIMS;
    this.baseUrl = (cfg.base_url || DEFAULT_BASE).replace(/\/+$/, "");
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
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (cfgDims(this.dims)) body.dimensions = this.dims;
    const t0 = Date.now();
    if (process.env.DF_LLM_DEBUG === "1") {
      console.log(`[embed] POST ${url} model=${this.model} texts=${texts.length} chars=${texts.reduce((s, t) => s + t.length, 0)}`);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }).catch((e) => {
      const cause = e instanceof Error && "cause" in e && e.cause instanceof Error ? ` cause=${e.cause.message}` : "";
      if (process.env.DF_LLM_DEBUG === "1") {
        console.log(`[embed] FAILED ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}${cause}`);
      }
      throw e;
    });
    if (process.env.DF_LLM_DEBUG === "1") {
      console.log(`[embed] OK ${Date.now() - t0}ms`);
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new MemoryError(
        ErrorCodes.INDEX,
        `OpenAI embeddings API 失败: ${res.status} ${res.statusText}`,
        { status: res.status, body: errBody.slice(0, 500), url },
      );
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    return json.data.map((d) => d.embedding);
  }
}

function cfgDims(dims: number): boolean {
  return Number.isFinite(dims) && dims > 0;
}
