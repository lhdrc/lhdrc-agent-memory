import { findRepoRoot, loadRepoConfig, resolveEnvDefaults, loadBrainConfig, resolveSourceIdFull, authorize, applyAgentScopeFromId, type AuthContext } from "@lhdrc/core";
import type { BrainConfig, RepoConfig } from "@lhdrc/core";

export interface CommandContext {
  repoRoot: string;
  brainId: string;
  sourceId: string;
  json: boolean;
  auth: AuthContext;
  cfg: RepoConfig;
  brainCfg: BrainConfig;
}

async function withAgentScope(
  repoRoot: string,
  brainId: string,
  auth: AuthContext,
): Promise<AuthContext> {
  const agentId = process.env.DF_MEMORY_AGENT?.trim();
  if (!agentId) return auth;
  return applyAgentScopeFromId(repoRoot, brainId, auth, agentId);
}

export async function loadContext(json: boolean): Promise<CommandContext> {
  const repoRoot = findRepoRoot();
  const cfg = await loadRepoConfig(repoRoot);
  const { brain } = resolveEnvDefaults(cfg);
  const brainId = brain ?? cfg.brain_id;
  const brainCfg = await loadBrainConfig(repoRoot, brainId);
  const sourceId = await resolveSourceIdFull({
    repoRoot,
    brainId,
    flag: undefined,
    cwd: process.cwd(),
    brain: brainCfg,
  });
  const auth = await withAgentScope(
    repoRoot,
    brainId,
    authorize(
      {
        channel: "cli",
        token: process.env.DF_MEMORY_TOKEN ?? null,
        brainId,
        sourceId,
      },
      cfg.auth,
    ),
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
  const auth = await withAgentScope(
    repoRoot,
    brainId,
    authorize(
      {
        channel: "cli",
        token: process.env.DF_MEMORY_TOKEN ?? null,
        brainId,
      },
      cfg.auth,
    ),
  );
  return { repoRoot, brainId, json, auth, cfg };
}

