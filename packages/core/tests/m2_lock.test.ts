import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { FileLock, ErrorCodes } from "../src/index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-lock-"));
});

describe("FileLock 写锁", () => {
  test("正常 acquire/release 幂等", async () => {
    const lock = new FileLock(join(dir, "write.lock"), 1000);
    await lock.acquire("test");
    expect(existsSync(join(dir, "write.lock"))).toBe(true);
    await lock.release();
    expect(existsSync(join(dir, "write.lock"))).toBe(false);
    await lock.release();
  });

  test("stale pid 的锁被打破并获取成功", async () => {
    const lockPath = join(dir, "write.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: "2026-01-01T00:00:00Z", owner: "dead" }));
    const warned: string[] = [];
    const lock = new FileLock(lockPath, 2000, (m) => warned.push(m));
    await lock.acquire("test");
    expect(warned.length).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(true);
    await lock.release();
  });

  test("活进程持有锁时超时抛 E_LOCK", async () => {
    const lockPath = join(dir, "write.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), owner: "me" }));
    const lock = new FileLock(lockPath, 200, () => {});
    await expect(lock.acquire("test")).rejects.toMatchObject({ code: ErrorCodes.LOCK });
  });

  test("两个锁实例竞争同一文件，串行互斥", async () => {
    const lockPath = join(dir, "write.lock");
    const events: string[] = [];
    const make = () => new FileLock(lockPath, 5000, () => {});
    const run = async (tag: string) => {
      const l = make();
      await l.acquire(tag);
      events.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, 30));
      events.push(`${tag}:end`);
      await l.release();
    };
    await Promise.all([run("a"), run("b")]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});
