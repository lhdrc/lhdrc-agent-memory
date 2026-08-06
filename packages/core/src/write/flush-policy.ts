import type { RepoConfig } from "../repo/config.ts";

export type GitMode = "off" | "batch" | "per_write";

export type ForceCommitKind = "entity_merge" | "schema_use" | "purge" | string;

export interface ExecuteOptions {
  /** 强制本步立即 git commit（D18 force_commit_on / 显式） */
  forceCommit?: boolean;
  /** 写入种类，用于匹配 force_commit_on */
  kind?: ForceCommitKind;
}

export type FlushReason = "explicit" | "batch" | "exit" | "force";

export function shouldForceCommit(cfg: RepoConfig, opts?: ExecuteOptions): boolean {
  if (opts?.forceCommit) return true;
  if (cfg.git.mode === "per_write") return true;
  const kind = opts?.kind;
  if (kind && cfg.git.force_commit_on.includes(kind)) return true;
  return false;
}

export function shouldBatchFlush(
  cfg: RepoConfig,
  writeCount: number,
  firstDirtyAt: string | null,
): boolean {
  if (cfg.git.mode !== "batch" || !cfg.git.auto_commit) return false;
  if (writeCount >= cfg.git.batch_size) return true;
  if (firstDirtyAt) {
    const elapsed = Date.now() - new Date(firstDirtyAt).getTime();
    if (Number.isFinite(elapsed) && elapsed >= cfg.git.batch_interval_ms) return true;
  }
  return false;
}
