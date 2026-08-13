export interface EvalCase {
  id: string;
  query: string;
  gold: string | string[];
  evidence?: string[];
  ingestTexts?: string[];
  meta?: Record<string, unknown>;
}

export interface AdapterLoadOptions {
  fixture: boolean;
  fixtureDir: string;
  cacheDir: string;
}

export interface EvalAdapter {
  id: string;
  load(opts: AdapterLoadOptions): Promise<EvalCase[]>;
  score(output: unknown, gold: unknown): number;
}
