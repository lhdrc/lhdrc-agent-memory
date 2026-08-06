export interface IndexSyncHooks {
  /** 文件成功 commit 后回调；M3 由 PGLite 增量同步实现，M2 默认 no-op。 */
  onFilesCommitted(repoRoot: string, paths: string[]): Promise<void>;
}

export const noopIndexHooks: IndexSyncHooks = {
  onFilesCommitted: async () => {},
};
