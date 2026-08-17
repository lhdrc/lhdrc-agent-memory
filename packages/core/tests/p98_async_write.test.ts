/**
 * P9.8 写路径默认异步：JobRunner 入 core。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  acceptCaptureJob,
  acceptRememberJob,
  getJobRunner,
  readJob,
  ErrorCodes,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

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

async function disableIronLaw(repoRoot: string): Promise<void> {
  await patchMemoryYml(repoRoot, { iron_law: { backlink: false, source_suffix: false } });
}

async function runCli(
  repoRoot: string,
  args: string[],
): Promise<{ exit: number; out: string; err: string }> {
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

function slowLlm(delayMs: number): LLMProvider {
  return {
    id: "mock",
    async complete(_req: CompleteRequest): Promise<CompleteResult> {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        text: JSON.stringify({
          items: [{ type: "decision", title: "不应落盘", body: "超时后不得写入。", mentions: [] }],
        }),
      };
    },
    async judgeDistill() {
      return { candidate: "skip" as const, confidence: 0, rationale: "m" };
    },
    async generateAbstract(c: string) {
      return c.slice(0, 10);
    },
    async generateOverview(c: string[]) {
      return c.join("");
    },
    async refineExperience(ctx) {
      return { title: ctx.title, trigger: "t", procedure: "p", boundary: "b", body: ctx.candidate };
    },
  };
}

async function listSourceMd(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, "brains", "default", "sources");
  if (!existsSync(root)) return [];
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.name.endsWith(".md")) out.push(p);
    }
  };
  await walk(root);
  return out;
}

describe("P9.8 async write", () => {
  test("P98-01 capture 无 wait：500ms 内返回 accepted；随后 job done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-01-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const cfg = await loadRepoConfig(repoRoot);
    const pack = await loadPack();
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    const t0 = Date.now();
    const job = await acceptCaptureJob({
      repoRoot,
      brainId: "default",
      pack,
      queue,
      capture: {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "异步笔记",
        body: "body",
        createdBy: "cli:test",
      },
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(job.status).toBe("pending");
    const r = await runCli(repoRoot, [
      "capture",
      "--title",
      "CLI异步",
      "--type",
      "note",
      "--body",
      "cli-body",
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { accepted: boolean; task_id: string; status: string };
    expect(parsed.accepted).toBe(true);
    expect(parsed.task_id).toBeTruthy();
    const runner = getJobRunner(repoRoot, "default");
    expect((await runner.wait(job.task_id, 30_000)).status).toBe("done");
    expect((await runner.wait(parsed.task_id, 30_000)).status).toBe("done");
    expect(existsSync(join(repoRoot, ".dfmemory", "jobs", "default", `${parsed.task_id}.json`))).toBe(true);
  }, T);

  test("P98-02 --wait：返回时 path 已可 query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-02-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const r = await runCli(repoRoot, [
      "capture",
      "--wait",
      "--title",
      "同步笔记",
      "--type",
      "note",
      "--body",
      "可检索正文重试",
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { path: string; status: string };
    expect(parsed.path).toContain("brains/");
    expect(parsed.status).toBe("done");
    expect(existsSync(join(repoRoot, parsed.path))).toBe(true);
    const q = await runCli(repoRoot, ["query", "重试", "--json"]);
    expect(q.exit).toBe(0);
    expect(q.out).toContain("同步笔记");
  }, T);

  test("P98-03 remember 无 Key 无 wait：job failed E_DISABLED，无新 L0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-03-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const before = await listSourceMd(repoRoot);
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    const job = await acceptRememberJob({
      repoRoot,
      brainId: "default",
      sourceId: "default",
      createdBy: "cli:test",
      queue,
      sessionId: "",
      turns: [{ role: "user", text: "我们决定改重试" }],
    });
    const done = await getJobRunner(repoRoot, "default").wait(job.task_id, 30_000);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe(ErrorCodes.DISABLED);
    const stored = await readJob(repoRoot, "default", job.task_id);
    expect(stored?.status).toBe("failed");
    expect((await listSourceMd(repoRoot)).length).toBe(before.length);
  }, T);

  test("P98-04 同 brain 两次 capture 无 wait：串行 done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-04-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const cfg = await loadRepoConfig(repoRoot);
    const pack = await loadPack();
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    const a = await acceptCaptureJob({
      repoRoot,
      brainId: "default",
      pack,
      queue,
      capture: {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "一",
        body: "first",
        createdBy: "cli:test",
      },
    });
    const b = await acceptCaptureJob({
      repoRoot,
      brainId: "default",
      pack,
      queue,
      capture: {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "二",
        body: "second",
        createdBy: "cli:test",
      },
    });
    const runner = getJobRunner(repoRoot, "default");
    const da = await runner.wait(a.task_id, 60_000);
    const db = await runner.wait(b.task_id, 60_000);
    expect(da.status).toBe("done");
    expect(db.status).toBe("done");
    const ta = Date.parse(da.finished_at ?? "");
    const tb = Date.parse(db.started_at ?? "");
    expect(tb).toBeGreaterThanOrEqual(ta);
  }, T);

  test("P98-05 插件与 CLI 写同一 jobs 目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-05-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const r = await runCli(repoRoot, [
      "capture",
      "--title",
      "同目录",
      "--type",
      "note",
      "--body",
      "x",
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { task_id: string };
    const p = join(repoRoot, ".dfmemory", "jobs", "default", `${parsed.task_id}.json`);
    expect(existsSync(p)).toBe(true);
    const stored = await readJob(repoRoot, "default", parsed.task_id);
    expect(stored?.brain_id).toBe("default");
    expect(stored?.kind).toBe("capture");
  }, T);

  test("P98-06 job status 缺 id → E_JOB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-06-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["job", "status"]);
    expect(r.exit).not.toBe(0);
    expect(r.err).toMatch(/E_JOB|E_NOT_FOUND|task_id/);
  }, T);

  test("P98-08 超时 E_TIMEOUT 不写 L0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p98-08-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    await disableIronLaw(repoRoot);
    const before = await listSourceMd(repoRoot);
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    const job = await acceptRememberJob({
      repoRoot,
      brainId: "default",
      sourceId: "default",
      createdBy: "cli:test",
      queue,
      sessionId: "",
      turns: [{ role: "user", text: "我们决定改重试" }],
      llm: slowLlm(5_000),
      timeoutMs: 80,
    });
    const done = await getJobRunner(repoRoot, "default").wait(job.task_id, 15_000);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe(ErrorCodes.TIMEOUT);
    expect((await listSourceMd(repoRoot)).length).toBe(before.length);
  }, T);
});
