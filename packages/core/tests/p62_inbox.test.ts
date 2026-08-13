/**
 * P6.2 Inbox 归档
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  archiveSession,
  loadSession,
  markFailed,
  listInbox,
  ErrorCodes,
  loadExtracted,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

async function runCli(repoRoot: string, args: string[]): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env: { ...process.env, DF_MEMORY_ROOT: repoRoot },
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

describe("P6.2 Inbox", () => {
  test(
    "P62-01: archive 三行 turns → messages.jsonl 三行；meta.status=pending",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const { sessionId, dir: sdir } = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [
          { role: "user", text: "a" },
          { role: "assistant", text: "b" },
          { role: "user", text: "c" },
        ],
      });
      const raw = await readFile(join(sdir, "messages.jsonl"), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(3);
      const { meta } = await loadSession(repoRoot, "default", sessionId);
      expect(meta.status).toBe("pending");
    },
    T,
  );

  test(
    "P62-02: archive 后 query 不命中 inbox 文本",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-02-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "独有词ZXQINBOX999 不应进检索" }],
      });
      const q = await runCli(repoRoot, ["query", "ZXQINBOX999", "--json"]);
      expect(q.exit).toBe(0);
      const parsed = JSON.parse(q.out) as { results: unknown[] };
      expect(parsed.results.length).toBe(0);
    },
    T,
  );

  test(
    "P62-03: markFailed → failed.json.skipped=true；messages.jsonl 仍在",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const { sessionId, dir: sdir } = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "keep me" }],
      });
      await markFailed(repoRoot, "default", sessionId, { code: "E_LLM", message: "boom" });
      const failed = JSON.parse(await readFile(join(sdir, "failed.json"), "utf8")) as {
        skipped: boolean;
      };
      expect(failed.skipped).toBe(true);
      expect(existsSync(join(sdir, "messages.jsonl"))).toBe(true);
    },
    T,
  );

  test(
    "P62-04: 第一次 markFailed 后第二次 archive 新 sessionId 成功 pending",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const first = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "one" }],
      });
      await markFailed(repoRoot, "default", first.sessionId, { code: "E_LLM", message: "x" });
      const second = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "two" }],
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      const { meta } = await loadSession(repoRoot, "default", second.sessionId);
      expect(meta.status).toBe("pending");
    },
    T,
  );

  test(
    "P62-05: 成功 archive 目录内完整 messages+meta，无半截 json",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-05-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const { dir: sdir } = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "ok" }],
      });
      const names = (await readdir(sdir)).sort();
      expect(names).toEqual(["messages.jsonl", "meta.json"]);
      JSON.parse(await readFile(join(sdir, "meta.json"), "utf8"));
      expect(existsSync(`${sdir}.tmp`)).toBe(false);
    },
    T,
  );

  test("P62-06: sessionId 含 .. → E_PATH_ESCAPE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-06-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await expect(
      archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "x" }],
        sessionId: "foo/../bar",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.PATH_ESCAPE });
  });

  test(
    "P62-07: tool.text 超长 → 落盘长度 ≤ 配置上限",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const { sessionId } = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "tool", text: "x".repeat(5000) }],
        toolMaxChars: 2000,
      });
      const { turns } = await loadSession(repoRoot, "default", sessionId);
      expect(turns[0]!.text.length).toBeLessThanOrEqual(2000);
    },
    T,
  );

  test(
    "P62-08: 纯 complete 失败则无 extracted.json",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-08-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const { sessionId } = await archiveSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        turns: [{ role: "user", text: "x" }],
      });
      await markFailed(repoRoot, "default", sessionId, { code: "E_LLM", message: "no complete" });
      expect(await loadExtracted(repoRoot, "default", sessionId)).toBeNull();
    },
    T,
  );

  test(
    "init .gitignore 含 .dfmemory/inbox/",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p62-gi-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const gi = await readFile(join(repoRoot, ".gitignore"), "utf8");
      expect(gi).toContain(".dfmemory/inbox/");
    },
    T,
  );
});
