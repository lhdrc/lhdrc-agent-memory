import { findRepoRoot, loadRepoConfig, resolveEnvDefaults, loadBrainConfig, resolveSourceId } from "@df-memory/core";
import type { BrainConfig, RepoConfig } from "@df-memory/core";

export interface CommandContext {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  json: boolean;
}

export async function loadContext(json: boolean): Promise<CommandContext> {
  const repoRoot = findRepoRoot();
  const cfg = await loadRepoConfig(repoRoot);
  const { brain } = resolveEnvDefaults(cfg);
  const brainId = brain ?? cfg.brain_id;
  const brainCfg = await loadBrainConfig(repoRoot, brainId);
  const sourceId = process.env.DF_MEMORY_SOURCE ?? resolveSourceId(brainCfg);
  return { repoRoot, brainId, sourceId, json };
}

export async function loadNoSourceContext(json: boolean): Promise<{ repoRoot: string; brainId: string; json: boolean }> {
  const repoRoot = findRepoRoot();
  const cfg = await loadRepoConfig(repoRoot);
  const { brain } = resolveEnvDefaults(cfg);
  return { repoRoot, brainId: brain ?? cfg.brain_id, json };
}
