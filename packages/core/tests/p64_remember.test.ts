/**
 * P6.4 remember / ingest session / inbox
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { initMemoryRepo } from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const decisionFx = join(import.meta.dir, "../../adapters/ingest-session/fixtures/decision.jsonl");
const genericFx = join(import.meta.dir, "../../adapters/ingest-generic-jsonl/fixtures/two-notes.jsonl");

const DECISION_COMPLETE = JSON.stringify({
  items: [{ type: "decision", title: "重试改为固定3次", body: "重试策略改为固定3次，不再使用指数退避。", mentions: [] }],
});

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
  env?: Record<string, string | undefined>,
): Promise<{ exit: number; out: string; err: string }> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...env,
  };
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env: merged,
    stdin: "ignore",
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

async function enableMock(repoRoot: string): Promise<void> {
  await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
}

function mockEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    OPENAI_API_KEY: "sk-test",
    DF_MEMORY_MOCK_COMPLETE: DECISION_COMPLETE,
    ...extra,
  };
}

async function listSourceMd(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, "brains", "default", "sources");
  const out: string[] = [];
  async function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith(".md") && !e.name.includes(".overview.")) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

describe("P6.4 remember / session ingest", () => {
  test(
    "P64-01: dry-run 不写盘",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const before = await listSourceMd(repoRoot);
      const r = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--input", decisionFx, "--dry-run", "--json"],
        mockEnv(),
      );
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as { kept: unknown[]; session_id: string | null };
      expect(parsed.kept.length).toBeGreaterThanOrEqual(1);
      expect(parsed.session_id).toBeNull();
      expect((await listSourceMd(repoRoot)).length).toBe(before.length);
      expect(existsSync(join(repoRoot, ".dfmemory", "inbox", "sessions"))).toBe(false);
    },
    T,
  );

  test(
    "P64-02: remember --body 我们决定 → kept≥1 且有 path",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-02-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const r = await runCli(repoRoot, ["remember", "--body", "我们决定改用固定重试", "--json"], mockEnv());
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as { kept: Array<{ path?: string }> };
      expect(parsed.kept.length).toBeGreaterThanOrEqual(1);
      expect(parsed.kept[0]!.path).toBeTruthy();
    },
    T,
  );

  test(
    "P64-02b: provider=off 的 remember → E_DISABLED，无新 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-02b-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const before = await listSourceMd(repoRoot);
      const r = await runCli(repoRoot, ["remember", "--body", "我们决定 x"]);
      expect(r.exit).toBe(1);
      expect(r.err).toContain("E_DISABLED");
      expect((await listSourceMd(repoRoot)).length).toBe(before.length);
    },
    T,
  );

  test(
    "P64-03: remember 无参数 → E_USAGE 退出 2",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["remember"]);
      expect(r.exit).toBe(2);
      expect(r.err).toContain("E_USAGE");
    },
    T,
  );

  test(
    "P64-04: session ingest → inbox pending→done；sources 有 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const r = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--input", decisionFx, "--json"],
        mockEnv(),
      );
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as { session_id: string; kept: Array<{ path?: string }> };
      expect(parsed.kept.some((k) => k.path)).toBe(true);
      const listed = await runCli(repoRoot, ["inbox", "list", "--json"]);
      const sessions = JSON.parse(listed.out) as { sessions: Array<{ session_id: string; status: string }> };
      expect(sessions.sessions.some((s) => s.session_id === parsed.session_id && s.status === "done")).toBe(true);
    },
    T,
  );

  test(
    "P64-05: list-adapters 含 session / generic-jsonl / df-app",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-05-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["ingest", "--list-adapters"]);
      expect(r.exit).toBe(0);
      expect(r.out).toContain("session");
      expect(r.out).toContain("generic-jsonl");
      expect(r.out).toContain("df-app");
    },
    T,
  );

  test(
    "P64-06: 两行 user/assistant 不是两篇 note",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const r = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--input", decisionFx, "--json"],
        mockEnv(),
      );
      const parsed = JSON.parse(r.out) as { kept: unknown[] };
      expect(parsed.kept.length).toBe(1);
    },
    T,
  );

  test(
    "P64-07: mock LLM 失败后 --retry + mock 成功 → 编出 kept",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const fail = await runCli(repoRoot, ["ingest", "--adapter", "session", "--input", decisionFx, "--json"], {
        OPENAI_API_KEY: "sk-test",
        DF_MEMORY_MOCK_COMPLETE_FAIL: "1",
      });
      expect(fail.exit).toBe(1);
      const listed = await runCli(repoRoot, ["inbox", "list", "--json", "--status", "failed"]);
      const sessions = JSON.parse(listed.out) as { sessions: Array<{ session_id: string }> };
      expect(sessions.sessions.length).toBeGreaterThanOrEqual(1);
      const id = sessions.sessions[0]!.session_id;
      const retry = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--retry", id, "--json"],
        mockEnv(),
      );
      expect(retry.exit).toBe(0);
      const parsed = JSON.parse(retry.out) as { kept: Array<{ path?: string }> };
      expect(parsed.kept.some((k) => k.path)).toBe(true);
    },
    T,
  );

  test(
    "P64-07b: 写盘中途失败后 --retry → complete 次数不增加",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-07b-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const log = join(dir, "complete.log");
      const two = JSON.stringify({
        items: [
          { type: "note", title: "第一篇", body: "第一篇正文。", mentions: [] },
          { type: "note", title: "第二篇", body: "第二篇正文。", mentions: [] },
        ],
      });
      const first = await runCli(repoRoot, ["remember", "--body", "两篇", "--json"], {
        OPENAI_API_KEY: "sk-test",
        DF_MEMORY_MOCK_COMPLETE: two,
        DF_MEMORY_MOCK_COMPLETE_LOG: log,
      });
      expect(first.exit).toBe(0);
      const parsed = JSON.parse(first.out) as { session_id: string; kept: Array<{ path: string }> };
      const extractedAbs = join(
        repoRoot,
        ".dfmemory",
        "inbox",
        "sessions",
        "default",
        parsed.session_id,
        "extracted.json",
      );
      const ck = JSON.parse(await readFile(extractedAbs, "utf8")) as {
        items: Array<{ status: string; path?: string }>;
      };
      const second = ck.items[1]!;
      if (second.path) {
        const { unlink } = await import("node:fs/promises");
        await unlink(join(repoRoot, second.path)).catch(() => {});
      }
      second.status = "pending";
      delete second.path;
      await writeFile(extractedAbs, JSON.stringify(ck, null, 2), "utf8");
      const metaAbs = join(repoRoot, ".dfmemory", "inbox", "sessions", "default", parsed.session_id, "meta.json");
      const meta = JSON.parse(await readFile(metaAbs, "utf8")) as { status: string };
      meta.status = "failed";
      await writeFile(metaAbs, JSON.stringify(meta, null, 2), "utf8");
      const beforeLog = existsSync(log) ? await readFile(log, "utf8") : "";
      const retry = await runCli(
        repoRoot,
        ["ingest", "--adapter", "session", "--retry", parsed.session_id, "--json"],
        {
          OPENAI_API_KEY: "sk-test",
          DF_MEMORY_MOCK_COMPLETE: two,
          DF_MEMORY_MOCK_COMPLETE_LOG: log,
        },
      );
      expect(retry.exit).toBe(0);
      const afterLog = await readFile(log, "utf8");
      expect(afterLog).toBe(beforeLog);
    },
    T,
  );

  test(
    "P64-08: HELP 含 session、dry-run、retry、list",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-08-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const rem = await runCli(repoRoot, ["remember", "--help"]);
      const ing = await runCli(repoRoot, ["ingest", "--help"]);
      const box = await runCli(repoRoot, ["inbox", "--help"]);
      expect(rem.out.toLowerCase()).toContain("dry-run");
      expect(ing.out).toContain("session");
      expect(ing.out).toContain("retry");
      expect(ing.out).toContain("dry-run");
      expect(box.out).toContain("list");
    },
    T,
  );

  test(
    "P64-09: generic-jsonl 两行 fixture 仍绿",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-09-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["ingest", "--adapter", "generic-jsonl", "--input", genericFx, "--json"]);
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as { paths: string[] };
      expect(parsed.paths.length).toBe(2);
    },
    T,
  );

  test(
    "P64-10: remember 无 --json → stdout 含 session_id=",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-10-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      const r = await runCli(repoRoot, ["remember", "--body", "我们决定 x"], mockEnv());
      expect(r.exit).toBe(0);
      expect(r.out).toContain("session_id=");
    },
    T,
  );

  test(
    "P64-11: 失败 ingest 后 inbox list → status=failed",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p64-11-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await enableMock(repoRoot);
      await runCli(repoRoot, ["ingest", "--adapter", "session", "--input", decisionFx], {
        OPENAI_API_KEY: "sk-test",
        DF_MEMORY_MOCK_COMPLETE_FAIL: "1",
      });
      const listed = await runCli(repoRoot, ["inbox", "list", "--json"]);
      const sessions = JSON.parse(listed.out) as { sessions: Array<{ status: string }> };
      expect(sessions.sessions.some((s) => s.status === "failed")).toBe(true);
    },
    T,
  );
});
