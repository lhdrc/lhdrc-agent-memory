export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  /** P9.2：fail-open 降级时记录来源 provider（openai/onnx） */
  readonly fallbackFrom?: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderId = "off" | "local" | "openai" | "onnx";

export interface EmbeddingConfig {
  provider: EmbeddingProviderId;
  model: string;
  dims?: number;
  openai_api_key_env: string;
  onnx_model_path?: string;
}

export type TokenmaxRerank = "off" | "local";

export interface TokenmaxConfig {
  expand: boolean;
  expand_n: number;
  rerank: TokenmaxRerank;
  rerank_top_n: number;
}

export interface HotnessConfig {
  enabled: boolean;
  half_life_days: number;
}

export interface SearchConfig {
  mode: "conservative" | "balanced" | "tokenmax";
  tokenmax: TokenmaxConfig;
  hotness: HotnessConfig;
  directory_prefilter: boolean;
  entity_boost: boolean;
  alias_hop: boolean;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  mode: "balanced",
  tokenmax: {
    expand: true,
    expand_n: 2,
    rerank: "off",
    rerank_top_n: 20,
  },
  hotness: {
    enabled: true,
    half_life_days: 30,
  },
  directory_prefilter: false,
  entity_boost: true,
  alias_hop: true,
};
