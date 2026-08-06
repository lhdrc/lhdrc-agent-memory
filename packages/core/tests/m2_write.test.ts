import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  createEntityRegistry,
  captureNode,
  forgetNode,
  readNode,
  listTree,
  renderTree,
  importPath,
  WriteValidator,
  parseFrontmatter,
  gitLog,
  MemoryError,
  ErrorCodes,
  serializeFrontmatter,
  hasValidFrontmatter,
  flushRepoLedger,
} from "../src/index.ts";
import type { CreateNodeRequest } from "../src/write/types.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;
let queue: WriteQueue;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-m2-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
  queue = await makeQueue();
});

function captureOpts(overrides: Partial<Parameters<typeof captureNode>[3]> = {}) {
  return {
    brainId: "default",
    sourceId: "default",
    schemaType: "decision",
    title: "重试策略",
    body: "网关超时改为固定重试 3 次，间隔 500ms。",
    createdBy: "cli:test",
    ...overrides,
  };
}

describe("M2 写入管线与 CLI", () => {
  test("M2-01 capture 生成文件（batch 下不立即 commit）", async () => {
    const before = await gitLog(repoRoot, 5);
    const rel = await captureNode(repoRoot, pack, queue, captureOpts());
    expect(rel).toContain("issues/general/decisions/");
    const abs = join(repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data.status).toBe("active");
    expect(data.title).toBe("重试策略");
    const after = await gitLog(repoRoot, 5);
    expect(after).toEqual(before);
  });

  test("M2-11 sync flush → git log 有账本 commit", async () => {
    await captureNode(repoRoot, pack, queue, captureOpts());
    const cfg = await loadRepoConfig(repoRoot);
    const result = await flushRepoLedger(repoRoot, cfg, "explicit", { throwOnError: true });
    expect(result.committed).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    const logs = await gitLog(repoRoot, 1);
    expect(logs[0]).toMatch(/memory: flush /);
  });

  test("M2-12 entity merge 强制即时 commit", async () => {
    const registry = createEntityRegistry(repoRoot, "default", queue);
    await registry.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
    await registry.create({ slug: "bob", title: "Bob", createdBy: "cli:test" });
    await registry.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:test" });
    const logs = await gitLog(repoRoot, 3);
    expect(logs.some((l) => l.includes("entity merge") && l.includes("bob") && l.includes("alice"))).toBe(true);
  });

  test("M2-13 索引 hook 抛错不删已写文件", async () => {
    const cfg = await loadRepoConfig(repoRoot);
    const warned: string[] = [];
    const q = new WriteQueue(
      repoRoot,
      cfg,
      {
        onFilesWritten: async () => {
          throw new Error("boom");
        },
      },
      (m) => warned.push(m),
    );
    const rel = await captureNode(repoRoot, pack, q, captureOpts({ title: "hook-fail-m2" }));
    expect(rel).toContain("hook-fail");
    expect(warned.some((w) => w.includes("[E_INDEX]"))).toBe(true);
    const exists = await stat(join(repoRoot, rel)).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  test("M2-02 缺 title → E_VALIDATION field=title，无新文件", async () => {
    await expect(captureNode(repoRoot, pack, queue, captureOpts({ title: "" }))).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    });
    const issuesDir = join(repoRoot, "brains/default/sources/default/issues/general/decisions");
    const hasDir = await stat(issuesDir).then(() => true).catch(() => false);
    if (hasDir) {
      const files = await readdir(issuesDir);
      expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(0);
    }
  });

  test("M2-03 同 path 二次 capture → E_CONFLICT", async () => {
    await captureNode(repoRoot, pack, queue, captureOpts({ schemaType: "requirement", title: "需求A" }));
    await expect(
      captureNode(repoRoot, pack, queue, captureOpts({ schemaType: "requirement", title: "需求A" })),
    ).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  test("M2-04 relativePath 含 ../ → E_PATH_ESCAPE", async () => {
    const req: CreateNodeRequest = {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "x",
      relativePath: "../escape.md",
      body: "body",
      createdBy: "cli:test",
    };
    const v = new WriteValidator(repoRoot, pack);
    const result = await v.validate(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCodes.PATH_ESCAPE);
  });

  test("M2-06 capture 后 read 输出含 title 与 body", async () => {
    const rel = await captureNode(repoRoot, pack, queue, captureOpts());
    const { raw } = await readNode(repoRoot, "default", rel.replace(/^brains\/default\//, ""));
    expect(raw).toContain("重试策略");
    expect(raw).toContain("固定重试 3 次");
  });

  test("M2-07 capture 后 tree 可见该文件", async () => {
    const rel = await captureNode(repoRoot, pack, queue, captureOpts());
    const nodes = await listTree(repoRoot, "default", "brains/default", 6);
    const flat = renderTree(nodes).join("\n");
    expect(flat).toContain("1-重试策略.md");
    expect(flat).toContain("decisions/");
  });

  test("M2-08 forget → status=archived，文件仍在", async () => {
    const rel = await captureNode(repoRoot, pack, queue, captureOpts());
    const relFromBrain = rel.replace(/^brains\/default\//, "");
    await forgetNode(repoRoot, rel, queue, "cli:test");
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data.status).toBe("archived");
    expect(data.archived_by).toBe("cli:test");
    const exists = await stat(join(repoRoot, rel)).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  test("M2-09 import 合法 md 成功；非法 frontmatter 失败", async () => {
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    const good = join(srcDir, "good.md");
    await writeFile(
      good,
      serializeFrontmatter(
        { title: "导入决策", schema_type: "decision", source: "default", path: "sources/default/issues/general/decisions/9-imported.md", created_by: "cli:test", status: "active" },
        "## 正文\nimported body",
      ),
    );
    const bad = join(srcDir, "bad.md");
    await writeFile(bad, "no frontmatter here\n");

    const goodRel = await importPath(repoRoot, pack, queue, good, { brainId: "default", sourceId: "default", createdBy: "cli:test" });
    expect(goodRel.length).toBe(1);
    expect(goodRel[0]!.destRel).toContain("9-imported.md");

    await expect(
      importPath(repoRoot, pack, queue, bad, { brainId: "default", sourceId: "default", createdBy: "cli:test" }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION });
  });

  test("M2-10 entity create 与 capture 共用同一锁队列，互不破坏", async () => {
    const registry = createEntityRegistry(repoRoot, "default", queue);
    const [entity, nodePath] = await Promise.all([
      registry.create({ slug: "alice", title: "Alice", createdBy: "cli:test" }),
      captureNode(repoRoot, pack, queue, captureOpts({ title: "并发安全" })),
    ]);
    expect(entity.status).toBe("active");
    const raw = await readFile(join(repoRoot, nodePath), "utf8");
    expect(hasValidFrontmatter(raw)).toBe(true);
  });

  test(
    "M2-05 并行两个 capture 进程：均成功或一个 E_LOCK，文件树一致无半写",
    async () => {
      const bunBin = process.execPath;
      const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
      const jobs = [0, 1].map((i) =>
        Bun.spawn({
          cmd: [
            bunBin,
            cliMain,
            "capture",
            "--title",
            `并行决策${i}`,
            "--type",
            "decision",
            "--body",
            `第 ${i} 个并行写入`,
          ],
          cwd: repoRoot,
          env: { ...process.env, DF_MEMORY_ROOT: repoRoot },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const results = await Promise.all(
        jobs.map(async (p) => {
          const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
          return { exit: await p.exited, out: out.trim(), err: err.trim() };
        }),
      );
      for (const r of results) {
        if (r.exit !== 0) {
          expect(r.exit).toBe(2);
          expect(r.err).toContain("E_LOCK");
        }
      }
      const dirAbs = join(repoRoot, "brains/default/sources/default/issues/general/decisions");
      const files = (await readdir(dirAbs)).filter((f) => f.endsWith(".md")).sort();
      expect(files).toHaveLength(2);
      for (const f of files) {
        const raw = await readFile(join(dirAbs, f), "utf8");
        const { data } = parseFrontmatter(raw);
        expect(data.status).toBe("active");
        expect(String(data.title)).toMatch(/^并行决策[01]$/);
      }
    },
    { timeout: 60_000 },
  );
});
