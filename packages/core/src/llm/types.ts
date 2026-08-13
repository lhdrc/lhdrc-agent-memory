export type DistillDecision = {
  candidate: "skip" | "create" | "none";
  item?: "merge" | "delete";
  targetExpId?: string;
  confidence: number;
  rationale: string;
};

export interface ExperienceContext {
  sourcePath: string;
  title: string;
  candidate: string;
  existingSummaries: string[];
}

export interface ExperienceResult {
  title: string;
  trigger: string;
  procedure: string;
  boundary: string;
  body: string;
}

export interface FactExtractMeta {
  event_type: string;
  attributed_to: string;
  at: string;
}

export interface ExtractFact {
  text: string;
  event_type: string;
  attributed_to: string;
  at: string;
}

export type CompletePurpose = "compile" | "extract" | "abstract" | "distill" | "other";

export type CompleteRequest = {
  prompt: string;
  system?: string;
  purpose: CompletePurpose;
};

export type CompleteResult = {
  text: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

export interface LLMProvider {
  readonly id: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
  judgeDistill(existing: string[], candidate: string): Promise<DistillDecision>;
  generateAbstract(content: string): Promise<string>;
  generateOverview(children: string[]): Promise<string>;
  refineExperience(ctx: ExperienceContext): Promise<ExperienceResult>;
  embed?(texts: string[]): Promise<number[][]>;
  extractFacts?(body: string, meta: FactExtractMeta): Promise<ExtractFact[]>;
}

export type LLMProviderId = "off" | "openai";

export interface LLMKillSwitch {
  distill: boolean;
  abstract: boolean;
  extract: boolean;
  compile: boolean;
}

export interface LLMConfig {
  provider: LLMProviderId;
  distill: boolean;
  extract: boolean;
  kill_switch: LLMKillSwitch;
  model: string;
  openai_api_key_env: string;
  base_url: string;
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: "off",
  distill: true,
  extract: false,
  kill_switch: {
    distill: false,
    abstract: false,
    extract: false,
    compile: false,
  },
  model: "gpt-4o-mini",
  openai_api_key_env: "OPENAI_API_KEY",
  base_url: "https://api.openai.com",
};
