export interface IndexSyncHooks {
  /**
   * 文件已落盘后回调（D18：可能尚未 git commit）。
   * M3 由 PGLite 增量同步实现；M2 默认 no-op。
   */
  onFilesWritten(repoRoot: string, paths: string[]): Promise<void>;
  /** @deprecated 别名，等价 onFilesWritten */
  onFilesCommitted?(repoRoot: string, paths: string[]): Promise<void>;
}

export const noopIndexHooks: IndexSyncHooks = {
  onFilesWritten: async () => {},
};

export async function invokeIndexHooks(hooks: IndexSyncHooks, repoRoot: string, paths: string[]): Promise<void> {
  if (hooks.onFilesWritten) {
    await hooks.onFilesWritten(repoRoot, paths);
    return;
  }
  if (hooks.onFilesCommitted) {
    await hooks.onFilesCommitted(repoRoot, paths);
  }
}
