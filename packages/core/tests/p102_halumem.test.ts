/**
 * P10.2 HaluMem-Medium adapter：compile + extract recall + QA（halumem-v1）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectHaluMemSessions } from "../../../evals/adapters/halumem.ts";
import { parseEvalArgv } from "../../../evals/lib/argv.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const repoRootSrc = join(import.meta.dir, "../../..");
const evalScript = join(repoRootSrc, "evals/run.ts");

const COMPILE_ONE = JSON.stringify({
  items: [
    {
      type: "note",
      title: "Alice Mochi and Rivermark Labs",
      body: "Alice adopted a corgi named Mochi. Alice started working at Rivermark Labs. Alice previously worked at Acme Corp before Rivermark Labs.",
      mentions: ["Alice", "Mochi"],
    },
  ],
  entities: [],
});

const OTHER_OK = "Mochi\nCORRECT\nRivermark Labs\nCORRECT";

async function spawn(
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, ...args],
    cwd: repoRootSrc,
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

async function receiptEnv(): Promise<{ dir: string; cache: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p102-receipt-"));
  const cache = await mkdtemp(join(tmpdir(), "dfmem-p102-cache-"));
  return {
    dir,
    cache,
    env: { DF_EVAL_RECEIPT_DIR: dir, DF_EVAL_CACHE_DIR: cache },
  };
}

function publishEnv(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    DF_EVAL_MOCK_EMBED: "1",
    DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
    DF_MEMORY_MOCK_COMPLETE_OTHER: OTHER_OK,
  };
}

function parseJsonLine(out: string): Record<string, unknown> {
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no json in stdout: ${out}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("P10.2 halumem publish", () => {
  test(
    "P102-01: 无 fetch 非 --fixture → 非 0",
    async () => {
      const { env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "halumem"], { env });
      expect(r.exit).not.toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/fixture|fetch --allow-net/i);
    },
    T,
  );

  test(
    "P102-02: --fixture protocol=halumem-v1；extract recall>0；qa n=2",
    async () => {
      const { dir, env } = await receiptEnv();
      const r = await spawn([evalScript, "--adapter", "halumem", "--fixture", "--json"], {
        env: publishEnv(env),
      });
      expect(r.exit).toBe(0);
      const body = parseJsonLine(r.out);
      expect(body.protocol).toBe("halumem-v1");
      const metrics = body.metrics as Record<string, unknown>;
      expect(metrics.protocol).toBe("halumem-v1");
      const extract = metrics.extract as Record<string, number>;
      expect(extract.integrity_n).toBeGreaterThanOrEqual(2);
      expect(extract.integrity_hits).toBeGreaterThanOrEqual(2);
      const qa = metrics.qa as Record<string, number>;
      expect(qa.n).toBe(2);
      expect(qa.hits).toBe(2);
      expect(typeof metrics.dataset_sha256).toBe("string");
      const receipt = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
        metrics: Record<string, unknown>;
        extra: Record<string, unknown>;
      };
      expect(Number(receipt.metrics.l0_written)).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "P102-03: fetch 未知 adapter 仍仅 locomo/halumem",
    async () => {
      const r = await spawn([evalScript, "fetch", "--adapter", "nope", "--allow-net"]);
      expect(r.exit).toBe(1);
      expect(`${r.out}\n${r.err}`).toMatch(/locomo|halumem/i);
    },
    T,
  );

  test("P102-04: --max-sessions 截断 compile 场数", () => {
    const sessions = [
      { session_index: 0, dialogue: [], memory_points: [] },
      { session_index: 1, dialogue: [], memory_points: [] },
      { session_index: 2, dialogue: [], memory_points: [], is_generated_qa_session: true },
      { session_index: 3, dialogue: [], memory_points: [] },
    ];
    const all = selectHaluMemSessions(sessions);
    expect(all.eligible).toBe(3);
    expect(all.sessions.map((s) => s.session_index)).toEqual([0, 1, 3]);
    const capped = selectHaluMemSessions(sessions, 2);
    expect(capped.sessions.map((s) => s.session_index)).toEqual([0, 1]);
    expect(capped.capped).toBe(true);
    expect(parseEvalArgv(["--max-sessions", "10"]).maxSessions).toBe(10);
    expect(() => parseEvalArgv(["--max-sessions", "0"])).toThrow(/正整数/);
  });
});
