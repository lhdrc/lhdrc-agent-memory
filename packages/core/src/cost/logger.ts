/**
 * P3.2 cost 记账：costs.jsonl + daily_token_cap。
 */
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirp } from "../util/fs.ts";
import type {
  LLMProvider,
  ExperienceContext,
  ExperienceResult,
  DistillDecision,
  CompleteRequest,
  CompleteResult,
} from "../llm/types.ts";
import type { RepoConfig } from "../repo/config.ts";

export interface CostConfig {
  daily_token_cap: number;
  log: string;
}

export interface CostEntry {
  at: string;
  kind: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  skipped?: boolean;
  reason?: string;
}

export function readCostConfig(cfg: RepoConfig): CostConfig {
  return cfg.cost ?? { daily_token_cap: 0, log: ".dfmemory/costs.jsonl" };
}

export async function appendCostEntry(
  repoRoot: string,
  costCfg: CostConfig,
  entry: Omit<CostEntry, "at"> & { at?: string },
): Promise<void> {
  const full: CostEntry = {
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    tokens_in: entry.tokens_in,
    tokens_out: entry.tokens_out,
    model: entry.model,
    skipped: entry.skipped,
    reason: entry.reason,
  };
  const abs = join(repoRoot, costCfg.log);
  await mkdirp(dirname(abs));
  await appendFile(abs, `${JSON.stringify(full)}\n`, "utf8");
}

export async function sumTokensToday(repoRoot: string, costCfg: CostConfig): Promise<number> {
  const abs = join(repoRoot, costCfg.log);
  if (!existsSync(abs)) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const raw = await readFile(abs, "utf8");
  let sum = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CostEntry;
      if (e.at?.startsWith(day) && !e.skipped) {
        sum += (e.tokens_in ?? 0) + (e.tokens_out ?? 0);
      }
    } catch {
      /* skip */
    }
  }
  return sum;
}

export async function wouldExceedCap(
  repoRoot: string,
  costCfg: CostConfig,
  estimate = 500,
): Promise<boolean> {
  if (!costCfg.daily_token_cap || costCfg.daily_token_cap <= 0) return false;
  const used = await sumTokensToday(repoRoot, costCfg);
  return used + estimate > costCfg.daily_token_cap;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * 包装 LLM：每次调用记账；超 cap 则跳过并记降级（调用方需处理异常/降级）。
 */
export function withCostAccounting(
  inner: LLMProvider,
  repoRoot: string,
  costCfg: CostConfig,
  defaultKind: string,
): LLMProvider {
  const wrap = async <T>(
    kind: string,
    inputText: string,
    fn: () => Promise<T>,
    outTextOf: (r: T) => string,
  ): Promise<T> => {
    if (await wouldExceedCap(repoRoot, costCfg)) {
      await appendCostEntry(repoRoot, costCfg, {
        kind,
        tokens_in: 0,
        tokens_out: 0,
        model: inner.id,
        skipped: true,
        reason: "daily_token_cap",
      });
      throw new Error(`cost cap exceeded for ${kind}`);
    }
    const result = await fn();
    const tokensIn = estimateTokens(inputText);
    const tokensOut = estimateTokens(outTextOf(result));
    await appendCostEntry(repoRoot, costCfg, {
      kind,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model: inner.id,
    });
    return result;
  };

  return {
    id: inner.id,
    judgeDistill(existing, candidate) {
      return wrap(
        `${defaultKind}:judgeDistill`,
        [...existing, candidate].join("\n"),
        () => inner.judgeDistill(existing, candidate),
        (r: DistillDecision) => r.rationale ?? "",
      );
    },
    generateAbstract(content) {
      return wrap(`${defaultKind}:abstract`, content, () => inner.generateAbstract(content), (r) => r);
    },
    generateOverview(children) {
      return wrap(
        `${defaultKind}:overview`,
        children.join("\n"),
        () => inner.generateOverview(children),
        (r) => r,
      );
    },
    refineExperience(ctx: ExperienceContext) {
      return wrap(
        `${defaultKind}:refineExperience`,
        `${ctx.title}\n${ctx.candidate}`,
        () => inner.refineExperience(ctx),
        (r: ExperienceResult) => `${r.title}\n${r.procedure}\n${r.boundary}`,
      );
    },
    complete(req: CompleteRequest) {
      return wrap(
        req.purpose === "compile" ? "compile" : `${defaultKind}:${req.purpose}`,
        `${req.system ?? ""}\n${req.prompt}`,
        () => inner.complete(req),
        (r: CompleteResult) => r.text,
      );
    },
    embed: inner.embed?.bind(inner),
    extractFacts: inner.extractFacts?.bind(inner),
  };
}

export async function readCostLog(repoRoot: string, costCfg: CostConfig): Promise<CostEntry[]> {
  const abs = join(repoRoot, costCfg.log);
  if (!existsSync(abs)) return [];
  const raw = await readFile(abs, "utf8");
  const out: CostEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CostEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}
