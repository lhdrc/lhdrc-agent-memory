/**
 * P10.1 LoCoMo J-score publish runner：compile + answer + judge；--fixture 仍属 P5.6。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const repoRootSrc = join(import.meta.dir, "../../..");
const evalScript = join(repoRootSrc, "evals/run.ts");

const COMPILE_ONE = JSON.stringify({
  items: [
    {
      type: "note",
      title: "Alice adopted corgi Mochi; Bob at Rivermark Labs",
      body: "Alice adopted a dog, a corgi named Mochi last Tuesday. Bob started working at Rivermark Labs. Mochi stole slippers twice.",
      mentions: ["Alice", "Bob", "Mochi"],
    },
  ],
  entities: [],
});

const OTHER_OK = "Mochi\nCORRECT\nRivermark Labs\nCORRECT";
const OTHER_BAD_JUDGE = "Mochi\nnot-a-verdict\nRivermark Labs\ngarbled";

async function spawn(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts?.env };
  const proc = Bun.spawn({
    cmd: [bunBin, ...args],
    cwd: opts?.cwd ?? repoRootSrc,
    env,
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

async function receiptEnv(): Promise<{ dir: string; cache: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p101-receipt-"));
  const cache = await mkdtemp(join(tmpdir(), "dfmem-p101-cache-"));
  return {
    dir,
    cache,
    env: { DF_EVAL_RECEIPT_DIR: dir, DF_EVAL_CACHE_DIR: cache },
  };
}

function publishEnv(base: Record<string, string>, extra?: Record<string, string>): Record<string, string> {
  return {
    ...base,
    DF_EVAL_MOCK_EMBED: "1",
    DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
    DF_MEMORY_MOCK_COMPLETE_OTHER: OTHER_OK,
    ...extra,
  };
}

function parseJsonLine(out: string): Record<string, unknown> {
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no json in stdout: ${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("P10.1 locomo publish", () => {
  test(
    "P101-01: --fixture 仍退出 0",
    async () => {
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo", "--fixture"], { env });
      expect(r.exit).toBe(0);
      expect(r.out).toMatch(/locomo|accuracy|ok/i);
    },
    T,
  );

  test(
    "P101-02: 无 fetch 非 --fixture → 非 0，消息含 fixture 或 fetch",
    async () => {
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo"], { env });
      expect(r.exit).not.toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/fixture|fetch --allow-net/i);
    },
    T,
  );

  test(
    "P101-03: --sample 走 compile；protocol=jscore-v1；n=2（无 category 5）",
    async () => {
      const { dir, env } = await receiptEnv();
      const log = join(dir, "complete.log");
      const r = await spawn([evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--json"], {
        env: publishEnv(env, { DF_MEMORY_MOCK_COMPLETE_LOG: log }),
      });
      expect(r.exit).toBe(0);
      const body = parseJsonLine(r.out);
      expect(body.protocol).toBe("jscore-v1");
      const metrics = body.metrics as Record<string, unknown>;
      expect(metrics.protocol).toBe("jscore-v1");
      expect(metrics.n).toBe(2);
      expect(metrics.prompt_hash).toBeTruthy();
      expect(typeof metrics.dataset_sha256).toBe("string");
      const extra = (JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as { extra: Record<string, unknown> })
        .extra;
      expect(extra.used_compile).toBe(true);
      expect(Number(extra.compile_sessions)).toBeGreaterThanOrEqual(1);
      expect(Number(extra.l0_written)).toBeGreaterThanOrEqual(1);
      expect(Number(extra.l0_written)).toBeLessThan(3);
      const logText = await readFile(log, "utf8");
      expect(logText).toMatch(/compile/);
      expect(logText).toMatch(/other/);
    },
    T,
  );

  test(
    "P101-04: mock compile E_DISABLED → compile_failed，不计分，不写 L0",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--json"], {
        env: {
          ...env,
          DF_EVAL_MOCK_EMBED: "1",
          DF_MEMORY_MOCK_COMPLETE_DISABLED: "1",
        },
      });
      expect(r.exit).toBe(0);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: { n: number };
        extra: { compile_failed: string[]; l0_written: number };
      };
      expect(latest.extra.compile_failed).toContain("fixture-0");
      expect(latest.metrics.n).toBe(0);
      expect(latest.extra.l0_written).toBe(0);
    },
    T,
  );

  test(
    "P101-05: 全量模式无 embed Key 且无 --allow-hash-embed → 非 0",
    async () => {
      const { env } = await receiptEnv();
      const saved = process.env.OPENAI_API_KEY;
      const r = await spawn([evalScript, "--adapter", "locomo", "--sample", "fixture-0"], {
        env: {
          ...env,
          OPENAI_API_KEY: "",
          SILICONFLOW_API_KEY: "",
          DF_EVAL_API_KEY: "",
          DF_EVAL_MOCK_EMBED: "",
        },
      });
      expect(r.exit).not.toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/allow-hash-embed|API_KEY|E_DISABLED/i);
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    },
    T,
  );

  test(
    "P101-06: judge 无法解析 → 该题 score=0",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--json"], {
        env: publishEnv(env, { DF_MEMORY_MOCK_COMPLETE_OTHER: OTHER_BAD_JUDGE }),
      });
      expect(r.exit).toBe(0);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: { n: number; hits: number };
        extra: { cases: Array<{ score: number; verdict: string }> };
      };
      expect(latest.metrics.n).toBe(2);
      expect(latest.metrics.hits).toBe(0);
      expect(latest.extra.cases.every((c) => c.score === 0 && c.verdict === "WRONG")).toBe(true);
    },
    T,
  );

  test(
    "P101-07: receipt 含 dataset_sha256 与 prompt_hash",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--json"], {
        env: publishEnv(env),
      });
      expect(r.exit).toBe(0);
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: { dataset_sha256: string; prompt_hash: { answer: string; judge: string } };
        extra: { dataset_sha256: string; prompt_hash: { answer: string } };
      };
      expect(latest.metrics.dataset_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(latest.metrics.prompt_hash.answer).toMatch(/^[a-f0-9]{64}$/);
      expect(latest.metrics.prompt_hash.judge).toMatch(/^[a-f0-9]{64}$/);
      expect(latest.extra.dataset_sha256).toBe(latest.metrics.dataset_sha256);
    },
    T,
  );

  test(
    "P101-08: --resume 第二次不重复 compile 已 qa_done 的 sample",
    async () => {
      const { dir, env } = await receiptEnv();
      const log = join(dir, "complete.log");
      const runId = "p101-resume";
      const base = publishEnv(env, { DF_MEMORY_MOCK_COMPLETE_LOG: log });
      const first = await spawn(
        [evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--run-id", runId, "--json"],
        { env: base },
      );
      expect(first.exit).toBe(0);
      const log1 = await readFile(log, "utf8");
      const compile1 = log1.split("\n").filter((l) => l.trim() === "compile").length;
      expect(compile1).toBeGreaterThanOrEqual(1);
      await writeFile(log, "", "utf8");
      const second = await spawn(
        [evalScript, "--adapter", "locomo", "--sample", "fixture-0", "--resume", runId, "--json"],
        { env: base },
      );
      expect(second.exit).toBe(0);
      const log2 = await readFile(log, "utf8");
      const compile2 = log2.split("\n").filter((l) => l.trim() === "compile").length;
      expect(compile2).toBe(0);
      const body = parseJsonLine(second.out);
      const extra = (body as { extra?: { skipped_samples?: number } }).extra;
      const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        extra: { skipped_samples: number; compile_sessions: number };
        metrics: { n: number };
      };
      expect(latest.extra.skipped_samples).toBeGreaterThanOrEqual(1);
      expect(latest.extra.compile_sessions).toBe(0);
      expect(latest.metrics.n).toBe(2);
      expect(extra ?? latest.extra).toBeTruthy();
    },
    T,
  );
});
