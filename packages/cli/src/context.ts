import { findRepoRoot, loadRepoConfig, resolveEnvDefaults, loadBrainConfig, resolveSourceId, authorize, type AuthContext } from "@df-memory/core";
import type { BrainConfig, RepoConfig } from "@df-memory/core";

export interface CommandContext {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  json: boolean;
  auth: AuthContext;
  cfg: RepoConfig;
  brainCfg: BrainConfig;
}

export async function loadContext(json: boolean): Promise<CommandContext> {
  const repoRoot = findRepoRoot();
  const cfg = await loadRepoConfig(repoRoot);
  const { brain } = resolveEnvDefaults(cfg);
  const brainId = brain ?? cfg.brain_id;
  const brainCfg = await loadBrainConfig(repoRoot, brainId);
  const sourceId = process.env.DF_MEMORY_SOURCE ?? resolveSourceId(brainCfg);
  const auth = authorize(
    {
      channel: "cli",
      token: process.env.DF_MEMORY_TOKEN ?? null,
      brainId,
      sourceId,
    },
    cfg.auth,
  );
  return { repoRoot, brainId, sourceId, json, auth, cfg, brainCfg };
}

export async function loadNoSourceContext(
  json: boolean,
): Promise<{ repoRoot: string; brainId: string; json: boolean; auth: AuthContext; cfg: RepoConfig }> {
  const repoRoot = findRepoRoot();
  const cfg = await loadRepoConfig(repoRoot);
  const { brain } = resolveEnvDefaults(cfg);
  const brainId = brain ?? cfg.brain_id;
  const auth = authorize(
    {
      channel: "cli",
      token: process.env.DF_MEMORY_TOKEN ?? null,
      brainId,
    },
    cfg.auth,
  );
  return { repoRoot, brainId, json, auth, cfg };
}
