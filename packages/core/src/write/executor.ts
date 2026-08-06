import { gitAdd, gitCommit } from "../repo/git.ts";
import type { ExecuteOptions } from "./flush-policy.ts";

/**
 * 文件变更执行器。
 * mutation 返回本次变更的仓内相对路径列表。
 */
export interface FileMutationExecutor {
  execute(mutation: () => Promise<string[]>, message: string, opts?: ExecuteOptions): Promise<string[]>;
}

/**
 * 无 WriteQueue 时的轻量执行器（M1 直调）：
 * 普通写入只落盘；forceCommit 才 git commit（merge 等）。
 */
export function directGitExecutor(repoRoot: string, commitPrefix = "memory:"): FileMutationExecutor {
  return {
    async execute(mutation, message, opts) {
      const paths = await mutation();
      if (paths.length === 0) return paths;
      if (opts?.forceCommit || opts?.kind === "entity_merge" || opts?.kind === "schema_use" || opts?.kind === "purge") {
        await gitAdd(repoRoot, paths);
        await gitCommit(repoRoot, `${commitPrefix} ${message}`.trim());
      }
      return paths;
    },
  };
}
