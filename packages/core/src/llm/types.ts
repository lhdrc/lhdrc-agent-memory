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

export interface LLMProvider {
  readonly id: string;
  judgeDistill(existing: string[], candidate: string): Promise<DistillDecision>;
  generateAbstract(content: string): Promise<string>;
  generateOverview(children: string[]): Promise<string>;
  refineExperience(ctx: ExperienceContext): Promise<ExperienceResult>;
  embed?(texts: string[]): Promise<number[][]>;
}

export type LLMProviderId = "off" | "openai";

export interface LLMKillSwitch {
  distill: boolean;
  abstract: boolean;
}

export interface LLMConfig {
  provider: LLMProviderId;
  distill: boolean;
  kill_switch: LLMKillSwitch;
}
