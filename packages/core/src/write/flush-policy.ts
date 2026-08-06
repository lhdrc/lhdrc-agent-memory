import type { RepoConfig } from "../repo/config.ts";

export type GitMode = "off" | "batch" | "per_write";

export type ForceCommitKind = "entity_merge" | "schema_use" | "purge" | string;

export interface ExecuteOptions {
  /** 强制本步立即 git commit（D18 force_commit_on）；mode=off 时无效 */
  forceCommit?: boolean;
  /** 写入种类，用于匹配 force_commit_on */
  kind?: ForceCommitKind;
}

export type FlushReason = "explicit" | "batch" | "exit" | "force";

/** mode=off 时永不自动/强制 commit，仅 explicit sync 可 flush。 */
export function shouldForceCommit(cfg: RepoConfig, opts?: ExecuteOptions): boolean {
  if (cfg.git.mode === "off") return false;
  if (opts?.forceCommit) return true;
  if (cfg.git.mode === "per_write") return true;
  const kind = opts?.kind;
  if (kind && cfg.git.force_commit_on.includes(kind)) return true;
  return false;
}

/**
 * batch 自动 flush：N 条 或 距上次账本 commit（lastFlushAt）≥ T。
 * lastFlushAt 为空时回退 firstDirtyAt（首窗尚未 flush 过）。
 */
export function shouldBatchFlush(
  cfg: RepoConfig,
  writeCount: number,
  lastFlushAt: string | null,
  firstDirtyAt: string | null,
): boolean {
  if (cfg.git.mode !== "batch" || !cfg.git.auto_commit) return false;
  if (writeCount >= cfg.git.batch_size) return true;
  const anchor = lastFlushAt ?? firstDirtyAt;
  if (anchor) {
    const elapsed = Date.now() - new Date(anchor).getTime();
    if (Number.isFinite(elapsed) && elapsed >= cfg.git.batch_interval_ms) return true;
  }
  return false;
}
