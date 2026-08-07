export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderId = "off" | "local" | "openai";

export interface EmbeddingConfig {
  provider: EmbeddingProviderId;
  model: string;
  dims?: number;
  openai_api_key_env: string;
}

export interface SearchConfig {
  mode: "conservative" | "balanced" | "tokenmax";
}
