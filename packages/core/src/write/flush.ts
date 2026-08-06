import { MemoryError, ErrorCodes } from "../errors.ts";
import type { RepoConfig } from "../repo/config.ts";
import { gitAdd, gitCommit, gitIsRepo } from "../repo/git.ts";
import { clearDirtyState, readDirtyState } from "./dirty.ts";
import type { FlushReason } from "./flush-policy.ts";

export interface FlushResult {
  committed: boolean;
  fileCount: number;
  message?: string;
}

/**
 * 将 dirty 路径刷入 git 账本（D18）。
 * 无 dirty / mode=off 且非 explicit·force → no-op。
 */
export async function flushDirtyLedger(
  repoRoot: string,
  cfg: RepoConfig,
  reason: FlushReason,
  opts?: {
    message?: string;
    /** explicit/force 失败抛错；batch/exit 默认 warn 不抛 */
    throwOnError?: boolean;
    warn?: (msg: string) => void;
  },
): Promise<FlushResult> {
  const warn = opts?.warn ?? ((m: string) => console.error(m));
  const throwOnError = opts?.throwOnError ?? (reason === "explicit" || reason === "force");

  if (cfg.git.mode === "off" && reason !== "explicit" && reason !== "force") {
    return { committed: false, fileCount: 0 };
  }

  const state = await readDirtyState(repoRoot);
  if (state.paths.length === 0) {
    return { committed: false, fileCount: 0 };
  }

  const isRepo = await gitIsRepo(repoRoot);
  if (!isRepo) {
    const msg = "不是 git 仓库，无法 flush 账本";
    if (throwOnError) throw new MemoryError(ErrorCodes.GIT, msg);
    warn(`[E_GIT] ${msg}`);
    return { committed: false, fileCount: state.paths.length };
  }

  const message =
    opts?.message ??
    (reason === "force"
      ? `${cfg.git.commit_prefix} flush ${state.paths.length} files`.trim()
      : `${cfg.git.commit_prefix} flush ${state.paths.length} files`.trim());

  try {
    await gitAdd(repoRoot, state.paths);
    await gitCommit(repoRoot, message);
    await clearDirtyState(repoRoot, new Date().toISOString());
    return { committed: true, fileCount: state.paths.length, message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (throwOnError) {
      if (e instanceof MemoryError) throw e;
      throw new MemoryError(ErrorCodes.GIT, `git flush 失败: ${msg}`);
    }
    warn(`[E_GIT] 账本 flush 失败（文件仍保留）: ${msg}`);
    return { committed: false, fileCount: state.paths.length };
  }
}
