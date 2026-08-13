/**
 * P5.8 ingest 适配器：generic-jsonl / df-app fixture；写入经 captureNode。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  ingestJsonl,
  captureNode,
  type IngestAdapter,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const repoSrc = join(import.meta.dir, "../../..");
const genericFx = join(repoSrc, "packages/adapters/ingest-generic-jsonl/fixtures");
const dfappFx = join(repoSrc, "packages/adapters/ingest-df-app/fixtures/sample-export.jsonl");

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

async function listNotes(repoRoot: string, brain = "default", source = "default"): Promise<string[]> {
  const dir = join(repoRoot, "brains", brain, "sources", source, "notes");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".md") && !f.includes(".overview."));
}

describe("P5.8 ingest adapters", () => {
  test("P58-01: ingest --list-adapters 含 generic-jsonl 与 df-app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-list-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["ingest", "--list-adapters"]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("generic-jsonl");
    expect(r.out).toContain("df-app");
  }, T);

  test("P58-02: 两行合法 jsonl → 两 path；query 命中标题词", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-ok-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, [
      "ingest",
      "--adapter",
      "generic-jsonl",
      "--input",
      join(genericFx, "two-notes.jsonl"),
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { paths: string[] };
    expect(parsed.paths.length).toBe(2);
    const q = await runCli(repoRoot, ["query", "重试策略", "--json"]);
    expect(q.exit).toBe(0);
    const hits = JSON.parse(q.out) as { results: Array<{ title: string }> };
    expect(hits.results.some((h) => h.title.includes("重试"))).toBe(true);
  }, T);

  test("P58-03: 缺 title → 非 0 且 errors[]；不写坏行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-bad-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, [
      "ingest",
      "--adapter",
      "generic-jsonl",
      "--input",
      join(genericFx, "bad-title.jsonl"),
      "--json",
    ]);
    expect(r.exit).not.toBe(0);
    const parsed = JSON.parse(r.out) as { paths: string[]; errors: unknown[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.paths.length).toBe(0);
    expect(await listNotes(repoRoot)).toEqual([]);
  }, T);

  test("P58-04: continue-on-error 好行落盘、坏行进 errors，退出 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-mix-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, [
      "ingest",
      "--adapter",
      "generic-jsonl",
      "--input",
      join(genericFx, "mixed.jsonl"),
      "--continue-on-error",
      "--json",
    ]);
    expect(r.exit).toBe(2);
    const parsed = JSON.parse(r.out) as { paths: string[]; errors: unknown[] };
    expect(parsed.paths.length).toBe(1);
    expect(parsed.errors.length).toBe(1);
    const notes = await listNotes(repoRoot);
    expect(notes.length).toBe(1);
    const raw = await readFile(join(repoRoot, "brains/default/sources/default/notes", notes[0]!), "utf8");
    expect(raw).toContain("P58MIXOK");
  }, T);

  test("P58-05: ingest 走 captureNode / 不直写 sources", async () => {
    const runSrc = await readFile(join(repoSrc, "packages/core/src/ingest/run.ts"), "utf8");
    expect(runSrc).toMatch(/captureNode/);
    expect(runSrc).not.toMatch(/writeFile/);

    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-spy-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const pack = await loadPack("problem-tree");
    const cfg = await loadRepoConfig(repoRoot);
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    let captures = 0;
    const spyAdapter: IngestAdapter = {
      id: "generic-jsonl",
      map(raw) {
        const o = raw as { title: string; body: string };
        return { title: o.title, body: o.body, schemaType: "note" };
      },
    };
    const result = await ingestJsonl({
      repoRoot,
      pack,
      queue,
      brainId: "default",
      createdBy: "p58",
      defaultSourceId: "default",
      adapter: spyAdapter,
      text: `{"title":"spy-a","body":"A"}\n{"title":"spy-b","body":"B"}\n`,
      capture: async (root, p, q, opts) => {
        captures++;
        return captureNode(root, p, q, opts);
      },
    });
    expect(captures).toBe(2);
    expect(result.paths.length).toBe(2);
  }, T);

  test("P58-06: df-app fixture → sources 落盘且 read 成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-dfapp-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, [
      "ingest",
      "--adapter",
      "df-app",
      "--input",
      dfappFx,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { paths: string[] };
    expect(parsed.paths.length).toBeGreaterThanOrEqual(1);
    expect(parsed.paths[0]).toMatch(/brains\/.+\/sources\//);
    const rd = await runCli(repoRoot, ["read", parsed.paths[0]!, "--json"]);
    expect(rd.exit).toBe(0);
    const body = JSON.parse(rd.out) as { content: string };
    expect(body.content.length).toBeGreaterThan(0);
  }, T);

  test("P58-07: ingest --help 说明 adapter、input、continue-on-error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p58-help-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["ingest", "--help"]);
    expect(r.exit).toBe(0);
    expect(r.out).toMatch(/adapter/i);
    expect(r.out).toMatch(/input/i);
    expect(r.out).toMatch(/continue-on-error/i);
  }, T);
});
