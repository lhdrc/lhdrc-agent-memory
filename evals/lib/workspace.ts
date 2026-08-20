import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createBrain,
  loadPack,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  type SchemaPack,
  type RepoConfig,
  type GitInitPolicy,
} from "../../packages/core/src/index.ts";

export interface EvalWorkspace {
  dir: string;
  repoRoot: string;
  pack: SchemaPack;
  cfg: RepoConfig;
  queue: WriteQueue;
  dispose(): Promise<void>;
}

export async function createEvalWorkspace(opts?: {
  brain?: string;
  extraBrains?: string[];
  git?: GitInitPolicy;
}): Promise<EvalWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-eval-"));
  const brain = opts?.brain ?? "default";
  const repoRoot = await initMemoryRepo(dir, {
    brain,
    source: "default",
    force: false,
    git: opts?.git,
  });
  for (const b of opts?.extraBrains ?? []) {
    if (b !== brain) await createBrain(repoRoot, b);
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
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
