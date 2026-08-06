import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdirp } from "../util/fs.ts";
import { MemoryError, ErrorCodes } from "../errors.ts";

export interface LockInfo {
  pid: number;
  acquiredAt: string;
  owner: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

export class FileLock {
  private held = false;
  private readonly lockPath: string;

  constructor(
    lockPath: string,
    private readonly timeoutMs: number,
    private readonly onWarn: (msg: string) => void = (m) => console.error(m),
  ) {
    this.lockPath = lockPath;
  }

  async acquire(owner: string): Promise<void> {
    if (this.held) return;
    const info: LockInfo = { pid: process.pid, acquiredAt: new Date().toISOString(), owner };
    const start = Date.now();
    for (;;) {
      try {
        await mkdirp(dirname(this.lockPath));
        await writeFile(this.lockPath, JSON.stringify(info), { flag: "wx" });
        this.held = true;
        return;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw e;
      }
      const existing = await this.readLock().catch(() => null);
      if (existing && !pidAlive(existing.pid)) {
        this.onWarn(`[WARN] 打破过期写锁（pid ${existing.pid} 不存在）: ${this.lockPath}`);
        await rm(this.lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - start >= this.timeoutMs) {
        throw new MemoryError(ErrorCodes.LOCK, `获取写锁超时（${this.timeoutMs}ms）: ${this.lockPath}`);
      }
      await sleep(100);
    }
  }

  private async readLock(): Promise<LockInfo | null> {
    const raw = await readFile(this.lockPath, "utf8");
    return JSON.parse(raw) as LockInfo;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    await rm(this.lockPath, { force: true }).catch(() => {});
    this.held = false;
  }
}
