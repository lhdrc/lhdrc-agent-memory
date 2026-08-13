import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { appendMemoryDiff } from "../distill/memory-diff.ts";
import { createLLMProvider } from "../llm/index.ts";
import { wouldExceedCap, readCostConfig, appendCostEntry } from "../cost/logger.ts";
import { todayUtc } from "./validator.ts";
import { checkDedupe } from "./dedupe.ts";
import { heuristicExtractFacts, validateFactsForAppend } from "./extract.ts";
import type { FileMutationExecutor } from "./executor.ts";
import type { Fact } from "./types.ts";

export interface EnrichResult {
  deduped?: boolean;
  extracted_facts?: number;
  skipped_reason?: string;
  error?: { code: string; message: string; errors?: unknown };
}

export interface EnrichOptions {
  repoRoot: string;
  brainId: string;
  path: string;
  queue: FileMutationExecutor;
  extract?: boolean;
  noDedupe?: boolean;
  extractFactsFn?: (body: string) => Fact[] | Promise<Fact[]>;
}

function buildDedupeText(data: Record<string, unknown>, body: string): string {
  const title = String(data.title ?? "");
  const facts = Array.isArray(data.facts)
    ? (data.facts as Array<{ text?: string }>).map((f) => f.text ?? "").join("\n")
    : "";
  return [title, facts, body].filter(Boolean).join("\n");
}

function shouldEnrich(
  cfg: Awaited<ReturnType<typeof loadRepoConfig>>,
  extract?: boolean,
): boolean {
  return Boolean(extract || cfg.llm.extract || cfg.write.dedupe_cosine > 0);
}

/**
 * P5.1 L0 写入后富化：余弦去重 + facts 提取（ADD-only append 到 frontmatter）。
 */
export async function enrichAfterWrite(opts: EnrichOptions): Promise<EnrichResult | undefined> {
  const cfg = await loadRepoConfig(opts.repoRoot);
  if (!shouldEnrich(cfg, opts.extract)) {
    return undefined;
  }

  const abs = join(opts.repoRoot, opts.path);
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const dedupeText = buildDedupeText(data, body);

  let skippedReason: string | undefined;

  if (!opts.noDedupe && cfg.write.dedupe_cosine > 0) {
    const dedupe = await checkDedupe(opts.repoRoot, opts.brainId, opts.path, dedupeText, cfg);
    if (dedupe.skipped_reason) {
      skippedReason = dedupe.skipped_reason;
    } else if (dedupe.duplicate) {
      await appendMemoryDiff(opts.repoRoot, opts.brainId, {
        op: "skip_duplicate",
        paths_written: [],
        paths_readonly_refs: [opts.path, dedupe.matchedPath ?? ""].filter(Boolean),
        decision: {
          matched_path: dedupe.matchedPath,
          threshold: cfg.write.dedupe_cosine,
        },
      });
      return { deduped: true };
    }
  }

  const wantExtract = opts.extract === true || cfg.llm.extract === true;
  if (!wantExtract) {
    return skippedReason ? { skipped_reason: skippedReason } : undefined;
  }

  if (cfg.llm.kill_switch.extract) {
    return { skipped_reason: skippedReason ?? "kill_switch" };
  }

  const meta = {
    event_type: String(data.schema_type ?? "note"),
    attributed_to: String(data.created_by ?? "system"),
    at: String(data.created_at ?? todayUtc()).slice(0, 10),
  };

  let newFacts: Fact[];
  const useLlm = !opts.extractFactsFn && cfg.llm.provider !== "off";

  if (opts.extractFactsFn) {
    newFacts = await opts.extractFactsFn(body);
  } else if (useLlm) {
    const provider = createLLMProvider(cfg.llm);
    if (!provider.extractFacts) {
      newFacts = heuristicExtractFacts(body, meta);
    } else {
      const costCfg = readCostConfig(cfg);
      if (await wouldExceedCap(opts.repoRoot, costCfg)) {
        await appendCostEntry(opts.repoRoot, costCfg, {
          kind: "extract",
          tokens_in: 0,
          tokens_out: 0,
          model: provider.id,
          skipped: true,
          reason: "daily_token_cap",
        });
        return { skipped_reason: skippedReason ?? "cost_cap" };
      }
      newFacts = await provider.extractFacts(body, meta);
    }
  } else {
    newFacts = heuristicExtractFacts(body, meta);
  }

  const validationErrors = validateFactsForAppend(newFacts);
  if (validationErrors.length > 0) {
    return {
      skipped_reason: skippedReason,
      error: {
        code: "E_VALIDATION",
        message: validationErrors.map((e) => `${e.field}: ${e.message}`).join("; "),
        errors: validationErrors,
      },
    };
  }

  if (newFacts.length === 0) {
    return skippedReason ? { skipped_reason: skippedReason, extracted_facts: 0 } : { extracted_facts: 0 };
  }

  const existing = Array.isArray(data.facts) ? (data.facts as Fact[]) : [];
  const merged = [...existing, ...newFacts];

  await opts.queue.execute(async () => {
    const updated = serializeFrontmatter({ ...data, facts: merged }, body);
    await writeFile(abs, updated, "utf8");
    return [opts.path];
  }, `enrich facts ${opts.path}`);

  return {
    extracted_facts: newFacts.length,
    ...(skippedReason ? { skipped_reason: skippedReason } : {}),
  };
}
