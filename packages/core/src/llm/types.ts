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

export interface LLMProvider {
  readonly id: string;
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
}

export interface LLMConfig {
  provider: LLMProviderId;
  distill: boolean;
  extract: boolean;
  kill_switch: LLMKillSwitch;
}
