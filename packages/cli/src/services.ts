import { loadRepoConfig, WriteQueue, pgliteIndexHooks } from "@lhdrc/core";

export async function createQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}
