import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProviderId, SearchConfig } from "../embed/types.ts";
import { DEFAULT_SEARCH_CONFIG } from "../embed/types.ts";
import type { LLMConfig, LLMProviderId } from "../llm/types.ts";
import { DEFAULT_LLM_CONFIG } from "../llm/types.ts";
import type { CostConfig } from "../cost/logger.ts";
import type { AuthConfig } from "../auth/types.ts";
import { parseAuthConfig } from "../auth/access-control.ts";

export interface WriteConfig {
  dedupe_cosine: number;
  dedupe_window: number;
}

export interface CompileConfig {
  dedupe_cosine: number;
  dedupe_window: number;
  max_input_chars: number;
  tool_max_chars: number;
  prefetch_topn: number;
  window_max_turns: number;
  window_max_chars: number;
  /** P8.1：异步 compile / remember 任务超时（毫秒）。 */
  job_timeout_ms: number;
}

export interface RecallConfig {
  threshold: number;
  min_query_chars: number;
  dedupe_window_s: number;
  force: boolean;
}

export const DEFAULT_COMPILE_CONFIG: CompileConfig = {
  dedupe_cosine: 0.95,
  dedupe_window: 200,
  max_input_chars: 32_000,
  tool_max_chars: 2000,
  prefetch_topn: 5,
  window_max_turns: 20,
  window_max_chars: 16_000,
  job_timeout_ms: 120_000,
};

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  threshold: 3,
  min_query_chars: 4,
  dedupe_window_s: 120,
  force: false,
};

export interface LayersConfig {
  auto: boolean;
  overview_max_chars: number;
  dir_aggregate: boolean;
}

export interface DistillConfig {
  /** compile 成功后未蒸 L0 达此数才懒蒸馏；≤0 关闭 */
  lazy_min_sources: number;
  auto_crystallize: boolean;
}

export const DEFAULT_DISTILL_CONFIG: DistillConfig = {
  lazy_min_sources: 5,
  auto_crystallize: true,
};

export interface RepoConfig {
  version: number;
  brain_id: string;
  schema_pack: string;
  write: WriteConfig;
  layers: LayersConfig;
  git: {
    mode: "off" | "batch" | "per_write";
    auto_commit: boolean;
    commit_prefix: string;
    batch_size: number;
    batch_interval_ms: number;
    force_commit_on: string[];
  };
  index: { engine: string; path: string };
  writer: { lock_file: string; lock_timeout_ms: number };
  embedding: EmbeddingConfig;
  search: SearchConfig;
  llm: LLMConfig;
  compile: CompileConfig;
  recall: RecallConfig;
  distill: DistillConfig;
  cost: CostConfig;
  auth: AuthConfig;
}

const DEFAULT_FORCE_COMMIT_ON = ["entity_merge", "schema_use", "purge"];

function parseEmbeddingProvider(raw: unknown): EmbeddingProviderId {
  const v = String(raw ?? "off");
  if (v === "off" || v === "local" || v === "openai") return v;
  return "off";
}

function parseSearchMode(raw: unknown): SearchConfig["mode"] {
  const v = String(raw ?? "balanced");
  if (v === "conservative" || v === "balanced" || v === "tokenmax") return v;
  return "balanced";
}

function parseSearchConfig(data: Record<string, any>): SearchConfig {
  const search = data.search ?? {};
  const tm = search.tokenmax ?? {};
  const hot = search.hotness ?? {};
  const rerankRaw = String(tm.rerank ?? DEFAULT_SEARCH_CONFIG.tokenmax.rerank);
  const rerank = rerankRaw === "local" ? "local" : "off";
  return {
    mode: parseSearchMode(search.mode),
    tokenmax: {
      expand: tm.expand !== false,
      expand_n: Number(tm.expand_n ?? DEFAULT_SEARCH_CONFIG.tokenmax.expand_n) || 2,
      rerank,
      rerank_top_n: Number(tm.rerank_top_n ?? DEFAULT_SEARCH_CONFIG.tokenmax.rerank_top_n) || 20,
    },
    hotness: {
      enabled: hot.enabled !== false,
      half_life_days: Number(hot.half_life_days ?? DEFAULT_SEARCH_CONFIG.hotness.half_life_days) || 30,
    },
    directory_prefilter: search.directory_prefilter === true,
    entity_boost: search.entity_boost !== false,
    alias_hop: search.alias_hop !== false,
  };
}

function parseLLMProvider(raw: unknown): LLMProviderId {
  const v = String(raw ?? "off");
  if (v === "off" || v === "openai") return v;
  return "off";
}

function parseLLMConfig(data: Record<string, any>): LLMConfig {
  const llm = data.llm ?? {};
  return {
    provider: parseLLMProvider(llm.provider),
    distill: llm.distill !== false,
    extract: llm.extract === true,
    kill_switch: {
      distill: llm.kill_switch?.distill === true,
      abstract: llm.kill_switch?.abstract === true,
      extract: llm.kill_switch?.extract === true,
      compile: llm.kill_switch?.compile === true,
    },
    model: String(llm.model ?? DEFAULT_LLM_CONFIG.model),
    openai_api_key_env: String(llm.openai_api_key_env ?? DEFAULT_LLM_CONFIG.openai_api_key_env),
    base_url: String(llm.base_url ?? DEFAULT_LLM_CONFIG.base_url),
  };
}

function parseDistillConfig(data: Record<string, any>): DistillConfig {
  const d = data.distill ?? {};
  const lazy = Number(d.lazy_min_sources);
  return {
    lazy_min_sources: Number.isFinite(lazy) ? lazy : DEFAULT_DISTILL_CONFIG.lazy_min_sources,
    auto_crystallize: d.auto_crystallize !== false,
  };
}

function parseCompileConfig(data: Record<string, any>): CompileConfig {
  const compile = data.compile ?? {};
  const inbox = data.inbox ?? {};
  return {
    dedupe_cosine: Number(compile.dedupe_cosine ?? DEFAULT_COMPILE_CONFIG.dedupe_cosine) || DEFAULT_COMPILE_CONFIG.dedupe_cosine,
    dedupe_window: Number(compile.dedupe_window ?? DEFAULT_COMPILE_CONFIG.dedupe_window) || DEFAULT_COMPILE_CONFIG.dedupe_window,
    max_input_chars: Number(compile.max_input_chars ?? DEFAULT_COMPILE_CONFIG.max_input_chars) || DEFAULT_COMPILE_CONFIG.max_input_chars,
    tool_max_chars:
      Number(compile.tool_max_chars ?? inbox.tool_max_chars ?? DEFAULT_COMPILE_CONFIG.tool_max_chars) ||
      DEFAULT_COMPILE_CONFIG.tool_max_chars,
    prefetch_topn: parsePrefetchTopn(compile.prefetch_topn),
    window_max_turns: parseWindowInt(compile.window_max_turns, DEFAULT_COMPILE_CONFIG.window_max_turns),
    window_max_chars: parseWindowInt(compile.window_max_chars, DEFAULT_COMPILE_CONFIG.window_max_chars),
      job_timeout_ms:
        Number(compile.job_timeout_ms ?? DEFAULT_COMPILE_CONFIG.job_timeout_ms) ||
        DEFAULT_COMPILE_CONFIG.job_timeout_ms,
  };
}

function parsePrefetchTopn(raw: unknown): number {
  if (raw == null || raw === "") return DEFAULT_COMPILE_CONFIG.prefetch_topn;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COMPILE_CONFIG.prefetch_topn;
  return Math.floor(n);
}

function parseWindowInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseRecallConfig(data: Record<string, any>): RecallConfig {
  const recall = data.recall ?? {};
  return {
    threshold: Number(recall.threshold ?? DEFAULT_RECALL_CONFIG.threshold) || DEFAULT_RECALL_CONFIG.threshold,
    min_query_chars: Number(recall.min_query_chars ?? DEFAULT_RECALL_CONFIG.min_query_chars) || DEFAULT_RECALL_CONFIG.min_query_chars,
    dedupe_window_s: Number(recall.dedupe_window_s ?? DEFAULT_RECALL_CONFIG.dedupe_window_s) || DEFAULT_RECALL_CONFIG.dedupe_window_s,
    force: recall.force === true,
  };
}

function parseWriteConfig(data: Record<string, any>): WriteConfig {
  const write = data.write ?? {};
  return {
    dedupe_cosine: Number(write.dedupe_cosine ?? 0) || 0,
    dedupe_window: Number(write.dedupe_window ?? 200) || 200,
  };
}

function parseLayersConfig(data: Record<string, any>): LayersConfig {
  const layers = data.layers ?? {};
  return {
    auto: layers.auto === true,
    overview_max_chars: Number(layers.overview_max_chars ?? 4000) || 4000,
    dir_aggregate: layers.dir_aggregate !== false,
  };
}

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, "memory.yml"), "utf8");
  } catch {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `memory.yml 不存在于 ${repoRoot}（不是记忆仓）`);
  }
  const data = (parseYaml(raw) ?? {}) as Record<string, any>;
  const modeRaw = String(data.git?.mode ?? "batch");
  const mode = modeRaw === "off" || modeRaw === "per_write" || modeRaw === "batch" ? modeRaw : "batch";
  return {
    version: data.version ?? 1,
    brain_id: data.brain_id ?? "default",
    schema_pack: data.schema_pack ?? "problem-tree",
    write: parseWriteConfig(data),
    layers: parseLayersConfig(data),
    git: {
      mode,
      auto_commit: data.git?.auto_commit ?? true,
      commit_prefix: data.git?.commit_prefix ?? "memory:",
      batch_size: Number(data.git?.batch_size ?? 20) || 20,
      batch_interval_ms: Number(data.git?.batch_interval_ms ?? 300_000) || 300_000,
      force_commit_on: Array.isArray(data.git?.force_commit_on)
        ? data.git.force_commit_on.map(String)
        : [...DEFAULT_FORCE_COMMIT_ON],
    },
    index: {
      engine: data.index?.engine ?? "pglite",
      path: data.index?.path ?? ".dfmemory/pglite",
    },
    writer: {
      lock_file: data.writer?.lock_file ?? ".dfmemory/write.lock",
      lock_timeout_ms: data.writer?.lock_timeout_ms ?? 30000,
    },
    embedding: {
      provider: parseEmbeddingProvider(data.embedding?.provider),
      model: String(data.embedding?.model ?? "text-embedding-3-small"),
      dims: data.embedding?.dims != null ? Number(data.embedding.dims) || undefined : undefined,
      openai_api_key_env: String(data.embedding?.openai_api_key_env ?? "OPENAI_API_KEY"),
    },
    search: parseSearchConfig(data),
    llm: parseLLMConfig(data),
    compile: parseCompileConfig(data),
    recall: parseRecallConfig(data),
    distill: parseDistillConfig(data),
    cost: {
      daily_token_cap: Number(data.cost?.daily_token_cap ?? 0) || 0,
      log: String(data.cost?.log ?? ".dfmemory/costs.jsonl"),
    },
    auth: parseAuthConfig(data.auth),
  };
}

/**
 * 确定 CLI 的起点目录：
 * 1. DF_MEMORY_ROOT 显式覆盖；
 * 2. `bun run` 执行脚本时 Bun 会把 cwd 切到 package.json 所在目录，但保留
 *    npm_config_local_prefix 为调用方原目录（specs/mvp/README 验收口令
 *    `cd demo && bun run memory -- ...` 依赖它）；
 * 3. 否则用 process.cwd()。
 */
export function invocationCwd(): string {
  if (process.env.DF_MEMORY_ROOT) {
    return resolve(process.env.DF_MEMORY_ROOT);
  }
  const prefix = process.env.npm_config_local_prefix;
  if (prefix && resolve(prefix) !== resolve(process.cwd())) {
    return resolve(prefix);
  }
  return process.cwd();
}

/** 从起点目录向上查找 memory.yml。 */
export function findRepoRoot(startDir?: string): string {
  let dir = resolve(startDir ?? invocationCwd());
  for (;;) {
    if (existsSync(join(dir, "memory.yml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, "未找到 memory.yml（请在记忆仓内运行）");
    }
    dir = parent;
  }
}

export function resolveEnvDefaults(cfg: RepoConfig): { brain: string; source: string } {
  const brain = process.env.DF_MEMORY_BRAIN ?? cfg.brain_id;
  const source = process.env.DF_MEMORY_SOURCE ?? "default";
  return { brain, source };
}
