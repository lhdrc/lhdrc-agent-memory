/**
 * P7.4 AI 建 entity + 统一 linkify + query 邻接
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
  compileSession,
  captureNode,
  captureWrite,
  createEntityRegistry,
  fileToEntity,
  loadExtracted,
  openPglite,
  hybridQueryDetailed,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
  type CaptureOptions,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

function mockLlm(text: string, onCall?: (req: CompleteRequest) => void): LLMProvider {
  return {
    id: "mock",
    async complete(req): Promise<CompleteResult> {
      onCall?.(req);
      return { text };
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

async function runCli(
  repoRoot: string,
  args: string[],
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = { ...process.env, DF_MEMORY_ROOT: repoRoot };
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

describe("P7.4 entity graph", () => {
  test(
    "P74-01: compile 建 entity 并挂 @slug",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "支付方案确认" }],
        llm: mockLlm(
          JSON.stringify({
            entities: [{ slug: "pay", title: "支付" }],
            items: [{ type: "note", title: "支付方案", body: "支付将走独立通道。", mentions: [] }],
          }),
        ),
      });
      const entAbs = join(repoRoot, "brains", "default", "entities", "pay.md");
      expect(existsSync(entAbs)).toBe(true);
      expect(fileToEntity(await readFile(entAbs, "utf8")).status).toBe("active");
      expect(r.kept[0]?.path).toBeTruthy();
      const body = await readFile(join(repoRoot, r.kept[0]!.path!), "utf8");
      expect(body).toContain("@pay");
      expect(r.entities_created).toContain("pay");
    },
    T,
  );

  test(
    "P74-02: 非法 slug 进 unresolved，items 仍写",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-02-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "支付" }],
        llm: mockLlm(
          JSON.stringify({
            entities: [{ slug: "支付", title: "支付系统" }],
            items: [{ type: "note", title: "仍要记下", body: "这条笔记应该落盘。", mentions: [] }],
          }),
        ),
      });
      expect(existsSync(join(repoRoot, "brains", "default", "entities", "支付.md"))).toBe(false);
      expect(r.unresolved.some((u) => u.includes("支付"))).toBe(true);
      expect(r.kept.length).toBe(1);
      expect(existsSync(join(repoRoot, r.kept[0]!.path!))).toBe(true);
    },
    T,
  );

  test(
    "P74-03: 已有 entity 只挂链，不新建文件",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      const before = (await readdir(join(repoRoot, "brains", "default", "entities"))).filter((f) =>
        f.endsWith(".md"),
      );
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "Alice 负责" }],
        llm: mockLlm(
          JSON.stringify({
            items: [{ type: "note", title: "Alice 负责清单", body: "Alice 负责发布清单。", mentions: [] }],
          }),
        ),
      });
      const after = (await readdir(join(repoRoot, "brains", "default", "entities"))).filter((f) =>
        f.endsWith(".md"),
      );
      expect(after.length).toBe(before.length);
      const body = await readFile(join(repoRoot, r.kept[0]!.path!), "utf8");
      expect(body).toContain("@alice");
    },
    T,
  );

  test(
    "P74-04: capture 挂已有 entity",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await createEntityRegistry(repoRoot, "default", queue).create({
        slug: "bob",
        title: "Bob",
        createdBy: "cli:test",
      });
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "见 Bob",
        body: "见 Bob",
        createdBy: "cli:test",
      });
      const raw = await readFile(join(repoRoot, path), "utf8");
      expect(raw).toContain("@bob");
    },
    T,
  );

  test(
    "P74-05: capture 不建新 entity",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-05-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "见 Carol",
        body: "见 Carol",
        createdBy: "cli:test",
      });
      expect(existsSync(join(repoRoot, "brains", "default", "entities", "carol.md"))).toBe(false);
    },
    T,
  );

  test(
    "P74-06: query 邻接臂",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await createEntityRegistry(repoRoot, "default", queue).create({
        slug: "pay",
        title: "支付",
        createdBy: "cli:test",
      });
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "支付通道",
        body: "支付将走独立通道。",
        createdBy: "cli:test",
      });
      const conn = await openPglite(repoRoot);
      try {
        const { hits, explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "支付方案",
          repoRoot,
          explain: true,
          skipCache: true,
        });
        expect(explain?.graph_mode).toBe("adjacency");
        expect(explain?.arms.graph.some((g) => g.path === path) || hits.some((h) => h.path === path)).toBe(true);
        expect(explain?.arms.graph.some((g) => g.path === path)).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P74-07: 关系句仍优先",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["graph-query", "谁提到了支付", "--json"]);
      expect(r.exit).toBe(0);
      const json = JSON.parse(r.out) as { mode: string };
      expect(json.mode).toBe("relational");
    },
    T,
  );

  test(
    "P74-08: 非模板 graph-query 标明 empty",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-08-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const r = await runCli(repoRoot, ["graph-query", "随便写点", "--json"]);
      expect(r.exit).toBe(0);
      expect(r.out).toContain("可改用 memory query");
      const json = JSON.parse(r.out) as { mode: string };
      expect(json.mode).toBe("empty");
    },
    T,
  );

  test(
    "P74-09: extracted 含 entities，retry 不二次 complete",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-09-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let completes = 0;
      const llm = mockLlm(
        JSON.stringify({
          entities: [{ slug: "pay", title: "支付" }],
          items: [
            { type: "note", title: "第一篇", body: "支付第一篇。", mentions: [] },
            { type: "note", title: "第二篇", body: "支付第二篇。", mentions: [] },
          ],
        }),
        () => {
          completes++;
        },
      );
      const r1 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "两篇" }],
        llm,
        captureWriteFn: async (root, p, opts: CaptureOptions) => {
          if (opts.title === "第一篇") throw new Error("boom-first");
          return captureWrite(root, p, opts);
        },
      });
      expect(completes).toBe(1);
      expect(existsSync(join(repoRoot, "brains", "default", "entities", "pay.md"))).toBe(true);
      const extracted = await loadExtracted(repoRoot, "default", r1.session_id!);
      expect(extracted?.entities?.some((e) => e.slug === "pay")).toBe(true);
      const nComplete = completes;
      const r2 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        sessionId: r1.session_id,
        llm,
      });
      expect(completes).toBe(nComplete);
      expect(r2.kept.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(repoRoot, "brains", "default", "entities", "pay.md"))).toBe(true);
    },
    T,
  );

  test(
    "P74-10: 两 entity + 两 item 恰好一次 execute",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p74-10-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const orig = queue.execute.bind(queue);
      let executes = 0;
      queue.execute = async (mutation, message, opts) => {
        executes++;
        return orig(mutation, message, opts);
      };
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "两实体两笔记" }],
        llm: mockLlm(
          JSON.stringify({
            entities: [
              { slug: "pay", title: "支付" },
              { slug: "lina", title: "Lina" },
            ],
            items: [
              { type: "note", title: "笔记甲", body: "支付由 Lina 跟。", mentions: [] },
              { type: "note", title: "笔记乙", body: "第二条独立笔记。", mentions: [] },
            ],
          }),
        ),
      });
      expect(executes).toBe(1);
    },
    T,
  );

  test("P74 prompt 含 entities 合同且 items 仍三类型", async () => {
    const { loadSessionExtractPrompt } = await import("../src/index.ts");
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain("entities");
    expect(prompt).toContain("{ \"items\": [] }");
    expect(prompt).toContain("### decision");
    expect(prompt).toContain("### lesson");
    expect(prompt).toContain("### note");
  });
});
