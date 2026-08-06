import { gitAdd, gitCommit } from "../repo/git.ts";

/**
 * 文件变更执行器。M1 用直接 git 提交；M2 起用 WriteQueue（持锁 + commit + 索引 hook）。
 * mutation 返回本次变更的仓内相对路径列表。
 */
export interface FileMutationExecutor {
  execute(mutation: () => Promise<string[]>, message: string): Promise<string[]>;
}

export function directGitExecutor(repoRoot: string, commitPrefix = "memory:"): FileMutationExecutor {
  return {
    async execute(mutation, message) {
      const paths = await mutation();
      if (paths.length === 0) return paths;
      await gitAdd(repoRoot, paths);
      await gitCommit(repoRoot, `${commitPrefix} ${message}`.trim());
      return paths;
    },
  };
}
