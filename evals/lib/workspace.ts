import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initMemoryRepo,
  createBrain,
  loadPack,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  type SchemaPack,
  type RepoConfig,
} from "../../packages/core/src/index.ts";

export interface EvalWorkspace {
  dir: string;
  repoRoot: string;
  pack: SchemaPack;
  cfg: RepoConfig;
  queue: WriteQueue;
  dispose(): Promise<void>;
}

/** OpenCode Zen chat 网关。muse-spark 走 Responses API（`.../v1/responses`），见 `llm/openai.ts`。 */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen";
export const OPENCODE_GO_DEFAULT_MODEL = "muse-spark-1.3-contributor-free";

function openCodeGoKeyEnv(): string | null {
  if (process.env.OPENCODE_API_KEY?.trim()) return "OPENCODE_API_KEY";
  if (process.env.OPENCODE_GO_API_KEY?.trim()) return "OPENCODE_GO_API_KEY";
  return null;
}

/** DF_EVAL_LLM=off 保持 init 默认；auto 时有 Go key 则改走 OpenCode Go；opencode-go 强制改。 */
async function applyEvalLlmGateway(repoRoot: string): Promise<void> {
  const mode = (process.env.DF_EVAL_LLM ?? "auto").trim().toLowerCase();
  if (mode === "off" || mode === "openai") return;
  const goEnv = openCodeGoKeyEnv();
  const wantGo = mode === "opencode-go" || (mode === "auto" && goEnv != null);
  if (!wantGo) return;

  const envName = goEnv ?? "OPENCODE_API_KEY";
  const model = process.env.DF_EVAL_LLM_MODEL?.trim() || OPENCODE_GO_DEFAULT_MODEL;
  const base = (process.env.DF_EVAL_LLM_BASE_URL?.trim() || OPENCODE_GO_BASE_URL).replace(/\/+$/, "");
  const path = join(repoRoot, "memory.yml");
  let yml = await readFile(path, "utf8");
  yml = yml.replace(/^llm:\n(?: {2}.*\n)+/m, (block) =>
    block
      .replace(/^( {2}provider:).*$/m, `$1 openai`)
      .replace(/^( {2}model:).*$/m, `$1 ${model}`)
      .replace(/^( {2}openai_api_key_env:).*$/m, `$1 ${envName}`)
      .replace(/^( {2}base_url:).*$/m, `$1 ${base}`),
  );
  await writeFile(path, yml, "utf8");
}

/**
 * 语义臂 / dream 跨文件矛盾需要真 embedding。
 * 有 SILICONFLOW_API_KEY（或 DF_EVAL_API_BASE）时改写 embedding 块；仅 OPENAI_API_KEY 时沿用 init 默认。
 */
async function applyEvalEmbedding(repoRoot: string): Promise<void> {
  const sf = process.env.SILICONFLOW_API_KEY?.trim();
  const base = process.env.DF_EVAL_API_BASE?.trim();
  const model = process.env.DF_EVAL_EMBED_MODEL?.trim();
  const dimsRaw = process.env.DF_EVAL_EMBED_DIMS?.trim();
  if (!sf && !base && !model && !dimsRaw) return;

  const path = join(repoRoot, "memory.yml");
  let yml = await readFile(path, "utf8");
  yml = yml.replace(/^embedding:\n(?: {2}.*\n)+/m, (block) => {
    let next = block;
    if (sf || base) {
      next = next
        .replace(/^( {2}provider:).*$/m, `$1 openai`)
        .replace(
          /^( {2}openai_api_key_env:).*$/m,
          `$1 ${sf ? "SILICONFLOW_API_KEY" : "OPENAI_API_KEY"}`,
        );
    }
    if (base) next = next.replace(/^( {2}base_url:).*$/m, `$1 ${base.replace(/\/+$/, "")}`);
    if (model) next = next.replace(/^( {2}model:).*$/m, `$1 ${model}`);
    if (dimsRaw && /^\d+$/.test(dimsRaw)) {
      next = next.replace(/^( {2}dims:).*$/m, `$1 ${dimsRaw}`);
    }
    return next;
  });
  await writeFile(path, yml, "utf8");
}

export async function createEvalWorkspace(opts?: {
  brain?: string;
  extraBrains?: string[];
  /** 持久目录（绝对或相对仓根）；设置后 dispose 不删盘，可供后续 query。 */
  persistDir?: string;
  /** 持久目录已存在时先清空再建（覆盖旧评测仓）。 */
  reset?: boolean;
}): Promise<EvalWorkspace> {
  const brain = opts?.brain ?? "default";
  let dir: string;
  let persist = false;
  if (opts?.persistDir?.trim()) {
    dir = resolve(opts.persistDir.trim());
    persist = true;
    if (opts.reset && existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
    await mkdir(dir, { recursive: true });
    const empty = !existsSync(join(dir, "memory.yml"));
    if (empty) {
      await initMemoryRepo(dir, { brain, source: "default", force: false });
    }
  } else {
    dir = await mkdtemp(join(tmpdir(), "dfmem-eval-"));
    await initMemoryRepo(dir, { brain, source: "default", force: false });
  }
  const repoRoot = dir;
  await applyEvalLlmGateway(repoRoot);
  await applyEvalEmbedding(repoRoot);
  for (const b of opts?.extraBrains ?? []) {
    if (b !== brain) {
      try {
        await createBrain(repoRoot, b);
      } catch {
        /* brain 已存在 */
      }
    }
  }
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return {
    dir,
    repoRoot,
    pack,
    cfg,
    queue,
    async dispose() {
      if (persist) return;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
