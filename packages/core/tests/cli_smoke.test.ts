/**
 * CLI 子进程冒烟测试：验证 argv 解析、退出码与 stdout 契约。
 * 覆盖 core 测试未触达的 packages/cli 薄封装层。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemoryRepo } from "../src/index.ts";

let dir: string;
let repoRoot: string;

const T = { timeout: 120_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

async function runCli(args: string[], cwd = repoRoot): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd,
    env: { ...process.env, DF_MEMORY_ROOT: cwd },
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-cli-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("CLI 冒烟", () => {
  test(
    "init + capture + query 端到端",
    async () => {
      const cap = await runCli([
        "capture",
        "--title",
        "CLI重试",
        "--type",
        "decision",
        "--body",
        "固定重试 3 次",
      ]);
      expect(cap.exit).toBe(0);
      expect(cap.out).toMatch(/brains\/default\/sources/);

      const q = await runCli(["query", "重试", "--limit", "5"]);
      expect(q.exit).toBe(0);
      expect(q.out).toContain("CLI重试");
    },
    T,
  );

  test(
    "query --json 输出合法 JSON",
    async () => {
      await runCli(["capture", "--title", "JSON测试", "--type", "note", "--body", "body"]);
      const q = await runCli(["query", "JSON", "--json"]);
      expect(q.exit).toBe(0);
      const parsed = JSON.parse(q.out) as { results: unknown[] };
      expect(Array.isArray(parsed.results)).toBe(true);
    },
    T,
  );

  test(
    "graph-query 不崩溃",
    async () => {
      await runCli(["capture", "--title", "支付", "--type", "note", "--body", "提到 [[支付]] 模块"]);
      const g = await runCli(["graph-query", "谁提到了支付"]);
      expect(g.exit).toBe(0);
    },
    T,
  );

  test(
    "forget --purge 返回 E_USAGE",
    async () => {
      const cap = await runCli(["capture", "--title", "待删", "--type", "note", "--body", "x"]);
      const path = cap.out.split("\n").pop() ?? cap.out;
      const f = await runCli(["forget", path, "--purge"]);
      expect(f.exit).toBe(2);
      expect(f.err).toContain("E_USAGE");
      expect(f.err).toContain("--purge 未实现");
    },
    T,
  );

  test(
    "brain create + --brain 隔离 capture",
    async () => {
      const b = await runCli(["brain", "create", "team-b"]);
      expect(b.exit).toBe(0);

      const cap = await runCli([
        "--brain",
        "team-b",
        "capture",
        "--title",
        "B仓笔记",
        "--type",
        "note",
        "--body",
        "仅 B 可见",
      ]);
      expect(cap.exit).toBe(0);
      expect(cap.out).toContain("brains/team-b/");

      const list = await runCli(["brain", "list"]);
      expect(list.exit).toBe(0);
      expect(list.out).toContain("team-b");
    },
    T,
  );

  test(
    "rebuild-index + sync --commit",
    async () => {
      await runCli(["capture", "--title", "索引", "--type", "note", "--body", "rebuild test"]);
      const rb = await runCli(["rebuild-index"]);
      expect(rb.exit).toBe(0);

      const sync = await runCli(["sync", "--commit"]);
      expect(sync.exit).toBe(0);
    },
    T,
  );

  test(
    "observer --json 输出 stats 结构",
    async () => {
      await runCli(["capture", "--title", "obs", "--type", "note", "--body", "x"]);
      await runCli(["query", "obs"]);
      const o = await runCli(["observer", "--json"]);
      expect(o.exit).toBe(0);
      const stats = JSON.parse(o.out) as { query_count: number; cost: { entries: number } };
      expect(typeof stats.query_count).toBe("number");
      expect(stats.cost).toBeDefined();
    },
    T,
  );

  test(
    "entity create + resolve",
    async () => {
      const c = await runCli(["entity", "create", "--slug", "dave", "--title", "Dave"]);
      expect(c.exit).toBe(0);
      const r = await runCli(["entity", "resolve", "dave"]);
      expect(r.exit).toBe(0);
      expect(r.out).toContain("dave");
    },
    T,
  );

  test(
    "缺参数 capture → E_USAGE exit 2",
    async () => {
      const r = await runCli(["capture", "--title", "无类型"]);
      expect(r.exit).toBe(2);
      expect(r.err).toMatch(/E_USAGE|E_VALIDATION/);
    },
    T,
  );

  test("layers --help 说明三层与目录文件", async () => {
    const r = await runCli(["layers", "--help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toMatch(/l0|abstract/i);
    expect(r.out).toContain("_overview.md");
  });
});
