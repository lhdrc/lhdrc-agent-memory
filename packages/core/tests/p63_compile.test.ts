/**
 * P6.3 会话编译器
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  compileSession,
  captureNode,
  captureWrite,
  createEntityRegistry,
  ErrorCodes,
  loadExtracted,
  loadSessionExtractPrompt,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
  type CaptureOptions,
} from "../src/index.ts";

const T = { timeout: 180_000 };

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
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

function mockLlm(text: string | ((req: CompleteRequest) => string), onCall?: (req: CompleteRequest) => void): LLMProvider {
  return {
    id: "mock",
    async complete(req): Promise<CompleteResult> {
      onCall?.(req);
      const t = typeof text === "function" ? text(req) : text;
      return { text: t };
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

function decisionJson(title = "重试改为固定3次", body = "重试策略改为固定3次，不再使用指数退避。", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    items: [{ type: "decision", title, body, mentions: [], ...extra }],
  });
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

describe("P6.3 compileSession", () => {
  test(
    "P63-01: mock complete 返回一条 decision → kept≥1 且有 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-01-"));
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
        turns: [{ role: "user", text: "我们决定重试改为固定 3 次" }],
        llm: mockLlm(decisionJson()),
      });
      expect(r.kept.length).toBeGreaterThanOrEqual(1);
      expect(r.kept[0]!.path).toBeTruthy();
      expect(existsSync(join(repoRoot, r.kept[0]!.path!))).toBe(true);
    },
    T,
  );

  test(
    "P63-02: mock 返回 {items:[]} → kept=[]；markDone",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-02-"));
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
        turns: [{ role: "user", text: "再试一次" }],
        llm: mockLlm(JSON.stringify({ items: [] })),
      });
      expect(r.kept).toEqual([]);
      const { loadSession } = await import("../src/index.ts");
      const { meta } = await loadSession(repoRoot, "default", r.session_id!);
      expect(meta.status).toBe("done");
    },
    T,
  );

  test(
    "P63-03: local embedding；先 capture 同类；再 compile 近似 → duplicate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-03-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, { embedding: { provider: "local" } });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const body = "支付网关超时后采用固定三次重试策略，间隔 200ms。";
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "重试策略 A",
        body,
        createdBy: "cli:test",
      });
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "记住这个" }],
        llm: mockLlm(decisionJson("重试策略 B", body)),
      });
      expect(r.dropped.some((d) => d.reason === "duplicate")).toBe(true);
    },
    T,
  );

  test(
    "P63-03b: embedding off；两句规范化相同 → 第二条 duplicate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-03b-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const payload = decisionJson("同一标题", "同一正文内容。");
      const r1 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "一" }],
        llm: mockLlm(payload),
      });
      expect(r1.kept.length).toBe(1);
      const r2 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "二" }],
        llm: mockLlm(payload),
      });
      expect(r2.dropped.some((d) => d.reason === "duplicate")).toBe(true);
    },
    T,
  );

  test(
    "P63-04: entity alice；body 提 Alice → @alice",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-04-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "和 Alice 开会" }],
        llm: mockLlm(decisionJson("和 Alice 的约定", "以后和 Alice 对齐网关超时策略。")),
      });
      const raw = await readFile(join(repoRoot, r.kept[0]!.path!), "utf8");
      expect(raw).toContain("@alice");
    },
    T,
  );

  test(
    "P63-05: 未登记专有名 → unresolved 非空",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-05-"));
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
        turns: [{ role: "user", text: "网关" }],
        llm: mockLlm(decisionJson("网关约定", "网关超时用固定重试。", { mentions: ["网关"] })),
      });
      expect(r.unresolved.length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P63-06: provider=off → E_DISABLED；无新 md；无 extracted.json",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const before = await listSourceMd(repoRoot);
      try {
        await compileSession({
          repoRoot,
          brainId: "default",
          sourceId: "default",
          createdBy: "cli:test",
          pack,
          queue,
          turns: [{ role: "user", text: "我们决定 x" }],
        });
        throw new Error("expected throw");
      } catch (e: any) {
        expect(e.code).toBe(ErrorCodes.DISABLED);
      }
      expect((await listSourceMd(repoRoot)).length).toBe(before.length);
      const inbox = join(repoRoot, ".dfmemory", "inbox", "sessions", "default");
      if (existsSync(inbox)) {
        for (const name of await readdir(inbox)) {
          expect(await loadExtracted(repoRoot, "default", name)).toBeNull();
        }
      }
    },
    T,
  );

  test(
    "P63-07: off 时即使正文含「我们决定」也不写 L0",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-07-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const before = await listSourceMd(repoRoot);
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "我们决定改用固定重试" }],
      }).catch(() => {});
      expect((await listSourceMd(repoRoot)).length).toBe(before.length);
    },
    T,
  );

  test(
    "P63-08: 两候选 → execute 恰好 1 次、captureWrite 两次",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-08-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let executes = 0;
      const orig = queue.execute.bind(queue);
      queue.execute = (mut, msg, opts) => {
        executes++;
        return orig(mut, msg, opts);
      };
      let writes = 0;
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "两件事" }],
        llm: mockLlm(
          JSON.stringify({
            items: [
              { type: "note", title: "笔记甲", body: "甲内容足够长。", mentions: [] },
              { type: "note", title: "笔记乙", body: "乙内容足够长。", mentions: [] },
            ],
          }),
        ),
        captureWriteFn: async (root, p, opts: CaptureOptions) => {
          writes++;
          return captureWrite(root, p, opts);
        },
      });
      expect(r.kept.length).toBe(2);
      expect(executes).toBe(1);
      expect(writes).toBe(2);
    },
    T,
  );

  test(
    "P63-09: turns 仅含 context 块内「我们决定」→ mock prompt 不含该句",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-09-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let prompt = "";
      await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [
          {
            role: "user",
            text: "<df-memory-context query=\"x\">我们决定改用固定重试</df-memory-context>\n你好",
          },
        ],
        llm: mockLlm(JSON.stringify({ items: [] }), (req) => {
          prompt = req.prompt;
        }),
      });
      expect(prompt).not.toContain("我们决定改用固定重试");
    },
    T,
  );

  test(
    "P63-10: 同 id 再 compile → 不新增 md",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-10-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      const r1 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "决定" }],
        llm: mockLlm(decisionJson()),
      });
      const n1 = (await listSourceMd(repoRoot)).length;
      const r2 = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        sessionId: r1.session_id,
      });
      expect((await listSourceMd(repoRoot)).length).toBe(n1);
      expect(r2.kept.length).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test("P63-11: session-extract-v1.md 含 schema、空数组、few-shot", async () => {
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain('"items"');
    expect(prompt).toContain("{ \"items\": [] }");
    expect(prompt).toContain("Few-shot");
    expect(prompt).toContain("decision");
  });

  test(
    "P63-12: 第二条 captureWrite 抛错 → 第一条在；retry 不调 complete",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-12-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      let writes = 0;
      let completes = 0;
      const llm = mockLlm(
        JSON.stringify({
          items: [
            { type: "note", title: "第一篇", body: "第一篇正文。", mentions: [] },
            { type: "note", title: "第二篇", body: "第二篇正文。", mentions: [] },
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
        captureWriteFn: async (root, p, opts) => {
          writes++;
          if (writes === 2) throw new Error("boom-second");
          return captureWrite(root, p, opts);
        },
      });
      expect(r1.kept.length).toBe(1);
      expect(existsSync(join(repoRoot, r1.kept[0]!.path!))).toBe(true);
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
        captureWriteFn: async (root, p, opts) => captureWrite(root, p, opts),
      });
      expect(completes).toBe(nComplete);
      expect(r2.kept.length).toBe(2);
    },
    T,
  );

  test(
    "P63-13: 两条同 title → 两个文件（-2 后缀），不整场 failed",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p63-13-"));
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
        turns: [{ role: "user", text: "同名" }],
        llm: mockLlm(
          JSON.stringify({
            items: [
              { type: "note", title: "同名笔记", body: "正文甲足够长。", mentions: [] },
              { type: "note", title: "同名笔记", body: "正文乙足够长。", mentions: [] },
            ],
          }),
        ),
      });
      expect(r.kept.length).toBe(2);
      const paths = r.kept.map((k) => k.path!);
      expect(new Set(paths).size).toBe(2);
      expect(paths.some((p) => /-2\.md$/.test(p))).toBe(true);
      const { loadSession } = await import("../src/index.ts");
      const { meta } = await loadSession(repoRoot, "default", r.session_id!);
      expect(meta.status).toBe("done");
    },
    T,
  );
});
