import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProviderId, SearchConfig } from "../embed/types.ts";
import type { LLMConfig, LLMProviderId } from "../llm/types.ts";
import type { CostConfig } from "../cost/logger.ts";
import type { AuthConfig } from "../auth/types.ts";
import { parseAuthConfig } from "../auth/access-control.ts";

export interface RepoConfig {
  version: number;
  brain_id: string;
  schema_pack: string;
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
    kill_switch: {
      distill: llm.kill_switch?.distill === true,
      abstract: llm.kill_switch?.abstract === true,
    },
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
    search: {
      mode: parseSearchMode(data.search?.mode),
    },
    llm: parseLLMConfig(data),
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
