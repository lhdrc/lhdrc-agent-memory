import { gitAdd, gitCommit } from "../repo/git.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { shouldForceCommit, type ExecuteOptions } from "./flush-policy.ts";

/**
 * 文件变更执行器。
 * mutation 返回本次变更的仓内相对路径列表。
 */
export interface FileMutationExecutor {
  execute(mutation: () => Promise<string[]>, message: string, opts?: ExecuteOptions): Promise<string[]>;
}

/**
 * 无 WriteQueue 时的轻量执行器（M1 直调）：
 * 普通写入只落盘；force 仅在 mode≠off 时 git commit。
 */
export function directGitExecutor(repoRoot: string, commitPrefix = "memory:"): FileMutationExecutor {
  return {
    async execute(mutation, message, opts) {
      const paths = await mutation();
      if (paths.length === 0) return paths;
      const cfg = await loadRepoConfig(repoRoot);
      // 允许调用方覆盖 prefix（测试/兼容）
      const prefix = commitPrefix || cfg.git.commit_prefix;
      if (!shouldForceCommit(cfg, opts)) return paths;
      await gitAdd(repoRoot, paths);
      await gitCommit(repoRoot, `${prefix} ${message}`.trim());
      return paths;
    },
  };
}
