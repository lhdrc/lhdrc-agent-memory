import { join } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { RepoConfig } from "../repo/config.ts";
import { gitAdd, gitCommit, gitCheckoutRollback } from "../repo/git.ts";
import type { FileMutationExecutor } from "./executor.ts";
import { FileLock } from "./lock.ts";
import type { IndexSyncHooks } from "./hooks.ts";
import { noopIndexHooks } from "./hooks.ts";

export type WriteJob =
  | { type: "create_node"; payload: unknown }
  | { type: "archive_node"; path: string; by: string }
  | { type: "entity_create"; payload: unknown }
  | { type: "entity_merge"; payload: unknown };

/**
 * 单写者串行写队列：进程内 mutex + 跨进程文件锁。
 * 每个 job：持锁 → mutation（含 TOCTOU 复查）→ git commit → 索引 hook → 放锁。
 * 若 commit 失败，回滚本次变更的文件并抛 E_GIT。
 */
export class WriteQueue implements FileMutationExecutor {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lockPath: string;
  private readonly commitPrefix: string;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly repoRoot: string,
    cfg: RepoConfig,
    private readonly hooks: IndexSyncHooks = noopIndexHooks,
    onLockWarn?: (msg: string) => void,
  ) {
    this.lockPath = join(repoRoot, cfg.writer.lock_file);
    this.commitPrefix = cfg.git.commit_prefix;
    this.lockTimeoutMs = cfg.writer.lock_timeout_ms;
    this.warn = onLockWarn ?? ((m) => console.error(m));
  }

  private warn: (msg: string) => void;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 串行执行一次文件变更并提交。 */
  execute(mutation: () => Promise<string[]>, message: string): Promise<string[]> {
    return this.enqueue(async () => {
      const lock = new FileLock(this.lockPath, this.lockTimeoutMs, this.warn);
      await lock.acquire("cli");
      let changed: string[] = [];
      try {
        changed = await mutation();
        if (changed.length > 0) {
          await gitAdd(this.repoRoot, changed);
          await gitCommit(this.repoRoot, `${this.commitPrefix} ${message}`.trim());
          await this.hooks.onFilesCommitted(this.repoRoot, changed);
        }
        return changed;
      } catch (e) {
        if (changed.length > 0) {
          await gitCheckoutRollback(this.repoRoot, changed).catch(() => {});
        }
        if (e instanceof MemoryError) throw e;
        throw new MemoryError(ErrorCodes.GIT, `写队列执行失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await lock.release();
      }
    });
  }

  async close(): Promise<void> {}
}
