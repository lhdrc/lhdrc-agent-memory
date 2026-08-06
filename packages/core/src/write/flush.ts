import { MemoryError, ErrorCodes } from "../errors.ts";
import type { RepoConfig } from "../repo/config.ts";
import { gitAdd, gitCommit, gitIsRepo } from "../repo/git.ts";
import { clearDirtyState, readDirtyState, writeDirtyState } from "./dirty.ts";
import type { FlushReason } from "./flush-policy.ts";

export interface FlushResult {
  committed: boolean;
  fileCount: number;
  message?: string;
}

/**
 * 将 dirty 路径刷入 git 账本（D18）。
 * - mode=off：仅 reason=explicit 可提交；force/batch/exit 均 no-op
 * - opts.paths：只提交子集（force 与失败的先验 dirty 隔离）
 */
export async function flushDirtyLedger(
  repoRoot: string,
  cfg: RepoConfig,
  reason: FlushReason,
  opts?: {
    /** 只提交这些路径；成功后从 dirty 中移除它们，保留其余 */
    paths?: string[];
    message?: string;
    /** explicit/force 失败抛错；batch/exit 默认 warn 不抛 */
    throwOnError?: boolean;
    warn?: (msg: string) => void;
  },
): Promise<FlushResult> {
  const warn = opts?.warn ?? ((m: string) => console.error(m));
  const throwOnError = opts?.throwOnError ?? (reason === "explicit" || reason === "force");

  // mode=off：只允许显式 sync --commit
  if (cfg.git.mode === "off" && reason !== "explicit") {
    return { committed: false, fileCount: 0 };
  }

  const state = await readDirtyState(repoRoot);
  const toCommit =
    opts?.paths && opts.paths.length > 0
      ? [...new Set(opts.paths)]
      : state.paths;
  if (toCommit.length === 0) {
    return { committed: false, fileCount: 0 };
  }

  const isRepo = await gitIsRepo(repoRoot);
  if (!isRepo) {
    const msg = "不是 git 仓库，无法 flush 账本";
    if (throwOnError) throw new MemoryError(ErrorCodes.GIT, msg);
    warn(`[E_GIT] ${msg}`);
    return { committed: false, fileCount: toCommit.length };
  }

  const message =
    opts?.message ?? `${cfg.git.commit_prefix} flush ${toCommit.length} files`.trim();

  try {
    await gitAdd(repoRoot, toCommit);
    await gitCommit(repoRoot, message);
    const now = new Date().toISOString();
    const remaining = state.paths.filter((p) => !toCommit.includes(p));
    if (remaining.length === 0) {
      await clearDirtyState(repoRoot, now);
    } else {
      await writeDirtyState(repoRoot, {
        paths: remaining,
        writeCount: Math.max(0, state.writeCount - 1),
        lastFlushAt: now,
        firstDirtyAt: state.firstDirtyAt,
      });
    }
    return { committed: true, fileCount: toCommit.length, message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (throwOnError) {
      if (e instanceof MemoryError) throw e;
      throw new MemoryError(ErrorCodes.GIT, `git flush 失败: ${msg}`);
    }
    warn(`[E_GIT] 账本 flush 失败（文件仍保留）: ${msg}`);
    return { committed: false, fileCount: toCommit.length };
  }
}
