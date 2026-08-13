/**
 * P5.6 评测体系：mini receipt、检索门禁、蒸馏 bench、report、locomo fixture、缺数据提示、CLI 对齐
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryRepo } from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const repoRootSrc = join(import.meta.dir, "../../..");
const evalScript = join(repoRootSrc, "evals/run.ts");
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

async function spawn(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, ...args],
    cwd: opts?.cwd ?? repoRootSrc,
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

async function receiptEnv(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p56-receipt-"));
  return { dir, env: { DF_EVAL_RECEIPT_DIR: dir } };
}

describe("P5.6 evals", () => {
  test(
    "P56-01: eval:mini 退出 0 且 receipt 含 metrics",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--mini"], { env });
      expect(r.exit).toBe(0);
      expect(r.out).toMatch(/ok|hitsA|metrics/i);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        ok: boolean;
        metrics: Record<string, unknown>;
      };
      expect(latest.ok).toBe(true);
      expect(latest.metrics).toBeTruthy();
      expect(typeof latest.metrics.hit_rate).toBe("number");
    },
    T,
  );

  test(
    "P56-02: 清空索引不 rebuild → mini 失败非 0",
    async () => {
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--mini", "--wipe-index"], { env });
      expect(r.exit).not.toBe(0);
    },
    T,
  );

  test(
    "P56-03: eval:distill 退出 0 且 with_experience ≥ without_experience",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--distill"], { env });
      expect(r.exit).toBe(0);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: {
          with_experience: { recall: number };
          without_experience: { recall: number };
        };
      };
      expect(latest.metrics.with_experience.recall).toBeGreaterThanOrEqual(
        latest.metrics.without_experience.recall,
      );
    },
    T,
  );

  test(
    "P56-04: 跑完 mini 后 eval:report 打印 metrics",
    async () => {
      const { env } = await receiptEnv();
      expect((await spawn([evalScript, "--mini"], { env })).exit).toBe(0);
      const report = await spawn([evalScript, "--report"], { env });
      expect(report.exit).toBe(0);
      expect(`${report.out}\n${report.err}`).toMatch(/metrics|hit_rate/i);
    },
    T,
  );

  test(
    "P56-05: --adapter locomo --fixture 对仓内样例退出 0",
    async () => {
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo", "--fixture"], { env });
      expect(r.exit).toBe(0);
      expect(r.out).toMatch(/locomo|accuracy|ok/i);
    },
    T,
  );

  test(
    "P56-06: 无 fixture 且未 fetch → 非 0 且提示 fixture 或 fetch --allow-net",
    async () => {
      const cache = await mkdtemp(join(tmpdir(), "dfmem-p56-cache-"));
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo"], {
        env: { ...env, DF_EVAL_CACHE_DIR: cache },
      });
      expect(r.exit).not.toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/fixture|fetch --allow-net/i);
    },
    T,
  );

  test(
    "P56-07: memory eval --mini 与 bun run eval:mini 同成功/失败语义",
    async () => {
      const memDir = await mkdtemp(join(tmpdir(), "dfmem-p56-cli-"));
      const repoRoot = await initMemoryRepo(memDir, { brain: "default", source: "default", force: false });
      const { env } = await receiptEnv();
      const direct = await spawn([evalScript, "--mini"], { env });
      const cli = await spawn([cliMain, "eval", "--mini"], {
        cwd: repoRoot,
        env: { ...env, DF_MEMORY_ROOT: repoRoot },
      });
      expect(cli.exit).toBe(direct.exit);
      expect(direct.exit).toBe(0);
      expect(`${cli.out}\n${direct.out}`).toMatch(/ok|hitsA|metrics/i);
    },
    T,
  );
});
