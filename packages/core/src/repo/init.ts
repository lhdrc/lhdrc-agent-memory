import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { loadPack } from "../schema/loadPack.ts";
import { gitInit, gitAddAll, gitCommit, ensureGitIdentity, gitIsRepo } from "./git.ts";

export type GitInitPolicy = "init" | "existing" | "off";

export interface InitOptions {
  brain: string;
  source: string;
  force: boolean;
  /** default "init" */
  git?: GitInitPolicy;
  /** default: off if git==="off" else "batch" */
  gitMode?: "off" | "batch" | "per_write";
}

export function memoryYml(
  brain: string,
  schemaPack: string,
  gitMode: "off" | "batch" | "per_write" = "batch",
): string {
  return `version: 1
brain_id: ${brain}
schema_pack: ${schemaPack}
git:
  mode: ${gitMode}
  auto_commit: true
  commit_prefix: "memory:"
  batch_size: 20
  batch_interval_ms: 300000
  force_commit_on:
    - entity_merge
    - schema_use
    - purge
index:
  # 单机默认 pglite；大规模可改 postgres 并设置 DF_MEMORY_DATABASE_URL
  engine: pglite
  path: .dfmemory/pglite
writer:
  lock_file: .dfmemory/write.lock
  lock_timeout_ms: 30000
embedding:
  provider: local
  model: hashed-bigram-384
  # openai model unused unless provider=openai
  openai_api_key_env: OPENAI_API_KEY
search:
  mode: balanced
  tokenmax:
    expand: true
    expand_n: 2
    rerank: off
    rerank_top_n: 20
  hotness:
    enabled: true
    half_life_days: 30
  directory_prefilter: false
  entity_boost: true
  alias_hop: true
llm:
  provider: off
  model: gpt-4o-mini
  openai_api_key_env: OPENAI_API_KEY
  base_url: https://api.openai.com
  distill: true
  extract: false
  kill_switch:
    distill: false
    abstract: false
    extract: false
    compile: false
compile:
  dedupe_cosine: 0.95
  dedupe_window: 200
  max_input_chars: 32000
  tool_max_chars: 2000
  prefetch_topn: 5
distill:
  lazy_min_sources: 5
  auto_crystallize: true
recall:
  threshold: 3
  min_query_chars: 4
  dedupe_window_s: 120
write:
  dedupe_cosine: 0
  dedupe_window: 200
layers:
  auto: false
  overview_max_chars: 4000
  dir_aggregate: true
cost:
  daily_token_cap: 0
  log: .dfmemory/costs.jsonl
`;
}

export function brainYml(brain: string, schemaPack: string, source: string): string {
  return `id: ${brain}
name: ${brain}
schema_pack: ${schemaPack}
sources:
  default: ${source}
created_at: "${new Date().toISOString()}"
`;
}

export function sourceMarker(sourceId: string, brainId: string): string {
  return `source_id: ${sourceId}\nbrain_id: ${brainId}\n`;
}

export const INITIAL_CREATED_PATHS = [
  "memory.yml",
  ".gitignore",
  ".dfmemory",
  "brains",
] as const;

export async function initMemoryRepo(dir: string, opts: InitOptions): Promise<string> {
  const abs = resolve(dir);
  const existed = existsSync(abs);
  if (existed && !opts.force) {
    const entries = await readdir(abs);
    if (entries.length > 0) {
      throw new MemoryError(ErrorCodes.USAGE, `目录非空: ${abs}（使用 --force 强制初始化）`);
    }
  }

  const pack = await loadPack("problem-tree");
  await mkdir(abs, { recursive: true });

  const gitPolicy = opts.git ?? "init";
  const gitMode = opts.gitMode ?? (gitPolicy === "off" ? "off" : "batch");

  try {
    await writeFile(join(abs, "memory.yml"), memoryYml(opts.brain, pack.id, gitMode));
    await writeFile(
      join(abs, ".gitignore"),
      ".dfmemory/pglite/\n.dfmemory/write.lock\n.dfmemory/index-meta.json\n.dfmemory/embedding-meta.json\n.dfmemory/git-dirty.json\n.dfmemory/costs.jsonl\n.dfmemory/inbox/\n",
    );

    await mkdir(join(abs, ".dfmemory", "logs"), { recursive: true });
    await writeFile(
      join(abs, ".dfmemory", "index-meta.json"),
      JSON.stringify({ schemaVersion: 1, lastSyncAt: null, fileCount: 0 }, null, 2),
    );

    const brainRoot = join(abs, "brains", opts.brain);
    await mkdir(join(brainRoot, "sources", opts.source), { recursive: true });
    await writeFile(join(brainRoot, "brain.yml"), brainYml(opts.brain, pack.id, opts.source));
    await writeFile(join(brainRoot, "sources", opts.source, ".dfmemory-source"), sourceMarker(opts.source, opts.brain));

    for (const d of pack.directories_on_init ?? []) {
      const p = d.replace(/^sources\/default/, `sources/${opts.source}`);
      await mkdir(join(brainRoot, p), { recursive: true });
    }
    for (const d of ["entities", "events", "experiences", "skills", "agents"]) {
      await mkdir(join(brainRoot, d), { recursive: true });
    }
    await writeFile(join(brainRoot, "contradictions.md"), "# Contradictions\n");

    if (gitPolicy !== "off") {
      let needInit = gitPolicy === "init";
      if (gitPolicy === "existing") {
        needInit = !(await gitIsRepo(abs));
      }
      if (needInit) {
        await gitInit(abs);
      }
      await ensureGitIdentity(abs);
      await gitAddAll(abs);
      await gitCommit(abs, `memory: init brain ${opts.brain}`);
    }
  } catch (e) {
    if (!existed || opts.force) {
      await rm(join(abs, "memory.yml"), { force: true }).catch(() => {});
      await rm(join(abs, ".gitignore"), { force: true }).catch(() => {});
      await rm(join(abs, ".dfmemory"), { recursive: true, force: true }).catch(() => {});
      await rm(join(abs, "brains"), { recursive: true, force: true }).catch(() => {});
      if (!existed) {
        await rm(abs, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw e;
  }
  return abs;
}
