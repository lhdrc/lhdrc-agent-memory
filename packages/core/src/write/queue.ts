import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { RepoConfig } from "../repo/config.ts";
import type { FileMutationExecutor } from "./executor.ts";
import { FileLock } from "./lock.ts";
import type { IndexSyncHooks } from "./hooks.ts";
import { noopIndexHooks, invokeIndexHooks } from "./hooks.ts";
import { addDirtyPaths, readDirtyState } from "./dirty.ts";
import { flushDirtyLedger } from "./flush.ts";
import { shouldBatchFlush, shouldForceCommit, type ExecuteOptions, type FlushReason } from "./flush-policy.ts";

export type WriteJob =
  | { type: "create_node"; payload: unknown }
  | { type: "archive_node"; path: string; by: string }
  | { type: "entity_create"; payload: unknown }
  | { type: "entity_merge"; payload: unknown };

/**
 * 单写者串行写队列（D18）：
 * 持锁 → 写 md → 索引 hook → 标记 dirty → 条件/强制 flush → 放锁。
 * 文件落盘后失败不回滚权威文件。
 */
export class WriteQueue implements FileMutationExecutor {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lockPath: string;
  private readonly cfg: RepoConfig;

  constructor(
    private readonly repoRoot: string,
    cfg: RepoConfig,
    private readonly hooks: IndexSyncHooks = noopIndexHooks,
    onLockWarn?: (msg: string) => void,
  ) {
    this.cfg = cfg;
    this.lockPath = join(repoRoot, cfg.writer.lock_file);
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

  /**
   * 串行执行一次文件变更。
   * @param message 强制 commit / per_write 时的 commit 说明
   */
  execute(mutation: () => Promise<string[]>, message: string, opts?: ExecuteOptions): Promise<string[]> {
    return this.enqueue(async () => {
      const lock = new FileLock(this.lockPath, this.cfg.writer.lock_timeout_ms, this.warn);
      await lock.acquire("cli");
      let changed: string[] = [];
      let written = false;
      try {
        changed = await mutation();
        if (changed.length === 0) return changed;
        written = true;

        try {
          await invokeIndexHooks(this.hooks, this.repoRoot, changed);
        } catch (hookErr) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
          this.warn(`[E_INDEX] 索引同步失败（文件已写入，可执行 rebuild-index）: ${msg}`);
        }

        const force = shouldForceCommit(this.cfg, opts);
        const commitMsg = `${this.cfg.git.commit_prefix} ${message}`.trim();

        if (force) {
          // 关键路径单独 commit：先刷掉既有 dirty，再只提交本 job
          const prior = await readDirtyState(this.repoRoot);
          if (prior.paths.length > 0) {
            await this.flushLocked("batch", undefined, false);
          }
          await addDirtyPaths(this.repoRoot, changed);
          await this.flushLocked("force", commitMsg, true);
        } else {
          const state = await addDirtyPaths(this.repoRoot, changed);
          if (shouldBatchFlush(this.cfg, state.writeCount, state.firstDirtyAt)) {
            await this.flushLocked("batch", undefined, false);
          }
        }

        return changed;
      } catch (e) {
        if (changed.length > 0 && !written) {
          await rollbackUntracked(this.repoRoot, changed).catch(() => {});
        }
        if (e instanceof MemoryError) throw e;
        throw new MemoryError(ErrorCodes.INTERNAL, `写队列执行失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await lock.release();
      }
    });
  }

  /** 显式 / 退出 flush（自行持锁）。 */
  async flush(reason: FlushReason, message?: string): Promise<{ committed: boolean; fileCount: number }> {
    return this.enqueue(async () => {
      const lock = new FileLock(this.lockPath, this.cfg.writer.lock_timeout_ms, this.warn);
      await lock.acquire("cli");
      try {
        return await this.flushLocked(reason, message, reason === "explicit" || reason === "force");
      } finally {
        await lock.release();
      }
    });
  }

  private async flushLocked(
    reason: FlushReason,
    message: string | undefined,
    throwOnError: boolean,
  ): Promise<{ committed: boolean; fileCount: number }> {
    const result = await flushDirtyLedger(this.repoRoot, this.cfg, reason, {
      message,
      throwOnError,
      warn: this.warn,
    });
    return { committed: result.committed, fileCount: result.fileCount };
  }

  async close(): Promise<void> {}
}

/** mutation 失败时尽量删掉本次新建文件（未跟踪路径）。 */
async function rollbackUntracked(repoRoot: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const abs = join(repoRoot, p);
    if (existsSync(abs)) {
      await unlink(abs).catch(() => {});
    }
  }
}

/** 供 sync CLI / 进程退出：持锁 flush dirty。 */
export async function flushRepoLedger(
  repoRoot: string,
  cfg: RepoConfig,
  reason: FlushReason,
  opts?: { message?: string; throwOnError?: boolean; warn?: (m: string) => void },
): Promise<{ committed: boolean; fileCount: number }> {
  const warn = opts?.warn ?? ((m: string) => console.error(m));
  const lock = new FileLock(join(repoRoot, cfg.writer.lock_file), cfg.writer.lock_timeout_ms, warn);
  await lock.acquire("flush");
  try {
    return await flushDirtyLedger(repoRoot, cfg, reason, {
      message: opts?.message,
      throwOnError: opts?.throwOnError ?? (reason === "explicit" || reason === "force"),
      warn,
    });
  } finally {
    await lock.release();
  }
}
