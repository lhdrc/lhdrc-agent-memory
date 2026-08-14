/**
 * P7.3 滑动窗口摄入
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { initMemoryRepo, openPointerPath, readOpenSessionId } from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const sessionFx = join(import.meta.dir, "../../adapters/ingest-session/fixtures/decision.jsonl");
const COMPILE_ONE = JSON.stringify({
  items: [{ type: "decision", title: "重试改为固定3次", body: "重试策略改为固定3次。", mentions: [] }],
});

function restoreEnv(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

async function patchMemoryYml(repoRoot: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  const raw = await readFile(path, "utf8");
  const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && data[k] && typeof data[k] === "object") {
      data[k] = { ...(data[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      data[k] = v;
    }
  }
  await writeFile(path, stringifyYaml(data), "utf8");
}

async function runCli(
  repoRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...extraEnv,
  };
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
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

async function listSourceMd(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, "brains", "default", "sources");
  const out: string[] = [];
  async function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

describe("P7.3 sliding window", () => {
  let repoRoot: string;
  const prev: Record<string, string | undefined> = {};
  const KEYS = [
    "DF_MEMORY_MOCK_COMPLETE",
    "DF_MEMORY_MOCK_COMPLETE_COMPILE",
    "DF_MEMORY_MOCK_COMPLETE_LOG",
    "DF_MEMORY_MOCK_COMPLETE_FAIL",
    "OPENAI_API_KEY",
  ];

  beforeEach(async () => {
    for (const k of KEYS) prev[k] = process.env[k];
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p73-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  });

  afterEach(() => {
    for (const k of KEYS) restoreEnv(k, prev[k]);
  });

  test("init 含 window_max_turns / window_max_chars", async () => {
    const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
    expect(yml).toContain("window_max_turns: 20");
    expect(yml).toContain("window_max_chars: 16000");
  });

  test(
    "P73-01 未满不 compile",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const log = join(repoRoot, "complete.log");
      const env = {
        DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
        DF_MEMORY_MOCK_COMPLETE_LOG: log,
      };
      const a = await runCli(repoRoot, ["remember", "--buffer", "--body", "第一句短", "--json"], env);
      const b = await runCli(repoRoot, ["remember", "--buffer", "--body", "第二句短", "--json"], env);
      expect(a.exit).toBe(0);
      expect(b.exit).toBe(0);
      const ja = JSON.parse(a.out) as { compiled: unknown; session_id: string };
      const jb = JSON.parse(b.out) as { compiled: unknown; buffered_turns: number };
      expect(ja.compiled).toBeNull();
      expect(jb.compiled).toBeNull();
      expect(jb.buffered_turns).toBe(2);
      if (existsSync(log)) {
        const raw = await readFile(log, "utf8");
        expect(raw).not.toContain("compile");
      }
      expect(await listSourceMd(repoRoot)).toEqual([]);
      const meta = JSON.parse(
        await readFile(join(repoRoot, ".dfmemory/inbox/sessions/default", ja.session_id, "meta.json"), "utf8"),
      ) as { status: string };
      expect(meta.status).toBe("pending");
    },
    T,
  );

  test(
    "P73-02 达 turns 自动 compile 并清 .open",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        compile: { window_max_turns: 2 },
      });
      const log = join(repoRoot, "complete.log");
      const env = {
        DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
        DF_MEMORY_MOCK_COMPLETE_LOG: log,
      };
      await runCli(repoRoot, ["remember", "--buffer", "--body", "t1", "--json"], env);
      const second = await runCli(repoRoot, ["remember", "--buffer", "--body", "t2", "--json"], env);
      expect(second.exit).toBe(0);
      const json = JSON.parse(second.out) as { compiled: { kept?: unknown[] } | null; session_id: string };
      expect(json.compiled).not.toBeNull();
      expect(existsSync(log) ? await readFile(log, "utf8") : "").toContain("compile");
      expect(await readOpenSessionId(repoRoot, "default")).toBeUndefined();
      expect(existsSync(openPointerPath(repoRoot, "default"))).toBe(false);
    },
    T,
  );

  test(
    "P73-03 --end 蒸剩余",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      await runCli(repoRoot, ["remember", "--buffer", "--body", "只缓冲一条", "--json"], {
        DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
      });
      const end = await runCli(repoRoot, ["inbox", "end", "--json"], {
        DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
      });
      expect(end.exit).toBe(0);
      const json = JSON.parse(end.out) as { session_id: string };
      const meta = JSON.parse(
        await readFile(join(repoRoot, ".dfmemory/inbox/sessions/default", json.session_id, "meta.json"), "utf8"),
      ) as { status: string };
      expect(["done", "failed"]).toContain(meta.status);
    },
    T,
  );

  test(
    "P73-04 remember 无 --buffer 立即 compile",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const r = await runCli(repoRoot, ["remember", "--body", "我们决定重试改为固定3次", "--json"], {
        DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE,
      });
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { kept: unknown[] };
      expect(json.kept.length).toBeGreaterThanOrEqual(1);
      expect(await readOpenSessionId(repoRoot, "default")).toBeUndefined();
    },
    T,
  );

  test(
    "P73-05 ingest 无 window 整文件一次 compile 不写 .open",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const r = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--input", sessionFx, "--json"],
        { DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE },
      );
      expect(r.exit).toBe(0);
      expect(await readOpenSessionId(repoRoot, "default")).toBeUndefined();
      expect(existsSync(openPointerPath(repoRoot, "default"))).toBe(false);
    },
    T,
  );

  test(
    "P73-06 off 可缓冲；--end → E_DISABLED",
    async () => {
      const buf = await runCli(repoRoot, ["remember", "--buffer", "--body", "离线缓冲", "--json"]);
      expect(buf.exit).toBe(0);
      const end = await runCli(repoRoot, ["ingest", "--adapter", "session", "--end", "--json"]);
      expect(end.exit).not.toBe(0);
      expect(`${end.out}\n${end.err}`).toMatch(/E_DISABLED|provider=off|DISABLED/);
      expect(await listSourceMd(repoRoot)).toEqual([]);
    },
    T,
  );

  test(
    "P73-07 无 open 时 end → E_NOT_FOUND",
    async () => {
      const r = await runCli(repoRoot, ["inbox", "end", "--json"]);
      expect(r.exit).not.toBe(0);
      expect(`${r.out}\n${r.err}`).toMatch(/E_NOT_FOUND|没有打开/);
    },
    T,
  );

  test(
    "P73-08 超限切窗：5 turns max=2 → 至少 2 次 compile + 一场 open",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        compile: { window_max_turns: 2 },
      });
      const fx = join(repoRoot, "five.jsonl");
      const lines = [1, 2, 3, 4, 5].map((i) => JSON.stringify({ role: "user", text: `turn-${i}` }));
      await writeFile(fx, lines.join("\n") + "\n", "utf8");
      const r = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--input", fx, "--window", "--json"],
        { DF_MEMORY_MOCK_COMPLETE_COMPILE: COMPILE_ONE },
      );
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { compiles?: unknown[]; buffered_turns?: number };
      expect((json.compiles ?? []).length).toBeGreaterThanOrEqual(2);
      const openId = await readOpenSessionId(repoRoot, "default");
      expect(openId).toBeTruthy();
      const meta = JSON.parse(
        await readFile(join(repoRoot, ".dfmemory/inbox/sessions/default", openId!, "meta.json"), "utf8"),
      ) as { status: string };
      expect(meta.status).toBe("pending");
    },
    T,
  );

  test(
    "P73-09 失败保留原文",
    async () => {
      await patchMemoryYml(repoRoot, {
        llm: { provider: "openai" },
        compile: { window_max_turns: 2 },
      });
      const env = { DF_MEMORY_MOCK_COMPLETE_FAIL: "1" };
      await runCli(repoRoot, ["remember", "--buffer", "--body", "a", "--json"], env);
      const second = await runCli(repoRoot, ["remember", "--buffer", "--body", "b", "--json"], env);
      expect(second.exit).not.toBe(0);
      const listed = await runCli(repoRoot, ["inbox", "list", "--json", "--status", "failed"]);
      const sessions = (JSON.parse(listed.out) as { sessions: Array<{ session_id: string }> }).sessions;
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const sid = sessions[0]!.session_id;
      const dir = join(repoRoot, ".dfmemory/inbox/sessions/default", sid);
      expect(existsSync(join(dir, "failed.json"))).toBe(true);
      expect(existsSync(join(dir, "messages.jsonl"))).toBe(true);
      const raw = await readFile(join(dir, "messages.jsonl"), "utf8");
      expect(raw).toContain("a");
      expect(raw).toContain("b");
    },
    T,
  );
});
