import { loadRepoConfig, WriteQueue, noopIndexHooks } from "@df-memory/core";

export async function createQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, noopIndexHooks);
}
