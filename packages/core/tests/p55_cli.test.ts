/**
 * P5.5 CLI 补全：find / think / eval --mini / agent 范围
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  writeExperience,
  issueToken,
  sha256Token,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const evalScript = join(import.meta.dir, "../../../evals/run.ts");

async function runCli(
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...opts?.env,
  };
  if (!opts?.env?.DF_MEMORY_TOKEN) delete env.DF_MEMORY_TOKEN;
  if (!opts?.env?.DF_MEMORY_AGENT) delete env.DF_MEMORY_AGENT;
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

function resultPaths(jsonOut: string): string[] {
  const parsed = JSON.parse(jsonOut) as { results: Array<{ path: string }> };
  return [...new Set(parsed.results.map((r) => r.path))].sort();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p55-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
});

describe("P5.5 find / think / eval / agent", () => {
  test(
    "P55-01: find 与 query 的 path 集合相等",
    async () => {
      expect(
        (await runCli(["capture", "--wait", "--title", "重试策略", "--type", "note", "--body", "固定三次重试"])).exit,
      ).toBe(0);
      const q = await runCli(["query", "重试", "--json"]);
      const f = await runCli(["find", "重试", "--json"]);
      expect(q.exit).toBe(0);
      expect(f.exit).toBe(0);
      expect(resultPaths(f.out)).toEqual(resultPaths(q.out));
    },
    T,
  );

  test(
    "P55-02: find flags 与 query 相同，退出 0",
    async () => {
      await runCli(["capture", "--wait", "--title", "x", "--type", "note", "--body", "x body"]);
      const r = await runCli(["find", "x", "--mode", "conservative", "--limit", "3"]);
      expect(r.exit).toBe(0);
    },
    T,
  );

  test(
    "P55-03: 空库 think hints 含 cold_start",
    async () => {
      const r = await runCli(["think", "任意", "--json"]);
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as { hints: string[]; notes: unknown[] };
      expect(parsed.hints.some((h) => /cold_start/i.test(h))).toBe(true);
    },
    T,
  );

  test(
    "P55-04: think 有数据时至少一个数组非空",
    async () => {
      expect(
        (await runCli(["capture", "--wait", "--title", "P55THINKTOKEN 笔记", "--type", "note", "--body", "P55THINKTOKEN"])).exit,
      ).toBe(0);
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      await writeExperience(repoRoot, pack, queue, {
        brainId: "default",
        title: "P55THINKTOKEN 经验",
        trigger: "P55THINKTOKEN",
        procedure: "先记再做",
        boundary: "不越权",
        sourcePaths: ["sources/default/x.md"],
      });
      const r = await runCli(["think", "P55THINKTOKEN", "--json"]);
      expect(r.exit).toBe(0);
      const parsed = JSON.parse(r.out) as {
        skills: unknown[];
        experiences: unknown[];
        notes: unknown[];
      };
      const nonempty =
        parsed.skills.length + parsed.experiences.length + parsed.notes.length;
      expect(nonempty).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P55-05: eval --mini 退出码与 evals/run.ts 一致且有摘要",
    async () => {
      const direct = Bun.spawn({
        cmd: [bunBin, evalScript],
        cwd: join(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [dOut, , dExit] = await Promise.all([
        new Response(direct.stdout).text(),
        new Response(direct.stderr).text(),
        direct.exited,
      ]);
      const cli = await runCli(["eval", "--mini"]);
      expect(cli.exit).toBe(dExit);
      expect(cli.out.length + cli.err.length).toBeGreaterThan(0);
      expect(`${cli.out}\n${dOut}`).toMatch(/ok|hitsA|eval/i);
    },
    T,
  );

  test(
    "P55-06: agent register + list",
    async () => {
      const reg = await runCli(["agent", "register", "--id", "bot", "--source", "default"]);
      expect(reg.exit).toBe(0);
      const list = await runCli(["agent", "list", "--json"]);
      expect(list.exit).toBe(0);
      const parsed = JSON.parse(list.out) as { agents: Array<{ id: string; sources: string[] }> };
      const bot = parsed.agents.find((a) => a.id === "bot");
      expect(bot).toBeDefined();
      expect(bot?.sources).toContain("default");
    },
    T,
  );

  test(
    "P55-07: --agent + member token 写登记 source 成功",
    async () => {
      expect((await runCli(["agent", "register", "--id", "bot", "--source", "default"])).exit).toBe(0);
      const issued = issueToken("member1", "default");
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml += `
auth:
  users:
    - id: member1
      role: member
      brains:
        default:
          role: member
          sources: ["*"]
  tokens:
    - id: ${issued.id}
      user: member1
      hash: "sha256:${sha256Token(issued.raw)}"
      brain: default
`;
      await writeFile(ymlPath, yml, "utf8");
      const cap = await runCli(
        [
          "--agent",
          "bot",
          "--token",
          issued.raw,
          "capture", "--wait",
          "--title",
          "agent默认源",
          "--type",
          "note",
          "--body",
          "ok",
          "--json",
        ],
      );
      expect(cap.exit).toBe(0);
      const path = (JSON.parse(cap.out) as { path: string }).path;
      expect(path).toContain("/sources/default/");
    },
    T,
  );

  test(
    "P55-08: agent 写未登记 source → E_FORBIDDEN，无新文件",
    async () => {
      expect((await runCli(["agent", "register", "--id", "bot", "--source", "default"])).exit).toBe(0);
      const other = await runCli([
        "capture", "--wait",
        "--title",
        "他源笔记",
        "--type",
        "note",
        "--source",
        "other",
        "--body",
        "exists",
        "--json",
      ]);
      expect(other.exit).toBe(0);
      const otherRoot = join(repoRoot, "brains", "default", "sources", "other");
      const before = existsSync(otherRoot) ? (await readdir(otherRoot, { recursive: true })).length : 0;

      const issued = issueToken("member1", "default");
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml += `
auth:
  users:
    - id: member1
      role: member
      brains:
        default:
          role: member
          sources: ["*"]
  tokens:
    - id: ${issued.id}
      user: member1
      hash: "sha256:${sha256Token(issued.raw)}"
      brain: default
`;
      await writeFile(ymlPath, yml, "utf8");

      const cap = await runCli([
        "--agent",
        "bot",
        "--token",
        issued.raw,
        "capture", "--wait",
        "--title",
        "越权写",
        "--type",
        "note",
        "--source",
        "other",
        "--body",
        "nope",
      ]);
      expect(cap.exit).toBe(2);
      expect(cap.err).toContain("E_FORBIDDEN");
      const after = existsSync(otherRoot) ? (await readdir(otherRoot, { recursive: true })).length : 0;
      expect(after).toBe(before);
    },
    T,
  );

  test(
    "P55-09: 无 --agent 时 capture/query 与现网一致",
    async () => {
      const cap = await runCli([
        "capture", "--wait",
        "--title",
        "兼容笔记",
        "--type",
        "note",
        "--body",
        "无 agent",
        "--json",
      ]);
      expect(cap.exit).toBe(0);
      const q = await runCli(["query", "兼容", "--json"]);
      expect(q.exit).toBe(0);
      expect(resultPaths(q.out).length).toBeGreaterThan(0);
    },
    T,
  );

  test("P55-10: HELP 列出 find、think、eval、agent", async () => {
    const r = await runCli(["help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("find");
    expect(r.out).toContain("think");
    expect(r.out).toContain("eval");
    expect(r.out).toContain("agent");
  });
});
