import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  forgetNode,
  createEntityRegistry,
  openPglite,
  bm25Query,
  rebuildIndex,
  syncPage,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-m3-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

async function capture(title: string, body: string, schemaType = "decision") {
  const queue = await makeQueue();
  return captureNode(repoRoot, pack, queue, {
    brainId: "default",
    sourceId: "default",
    schemaType,
    title,
    body,
    createdBy: "cli:test",
  });
}

async function query(q: string) {
  const conn = await openPglite(repoRoot);
  try {
    return await bm25Query(conn.db, { brainId: "default", query: q, limit: 10 });
  } finally {
    await conn.close();
  }
}

describe("M3 PGLite 索引与查询", () => {
  test("M3-01 capture 含「重试」→ query 命中", async () => {
    const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
    const hits = await query("重试");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe(rel);
  });

  test("M3-02 删 pglite 后 rebuild → query 仍命中（文件权威）", async () => {
    const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
    await rm(join(repoRoot, ".dfmemory", "pglite"), { recursive: true, force: true });
    const { fileCount } = await rebuildIndex(repoRoot);
    expect(fileCount).toBeGreaterThan(0);
    const hits = await query("重试");
    expect(hits.some((h) => h.path === rel)).toBe(true);
  });

  test("M3-03 forget 节点 → query 默认结果不含该 path", async () => {
    const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
    const queue = await makeQueue();
    await forgetNode(repoRoot, rel, queue, "cli:test");
    const hits = await query("重试");
    expect(hits.some((h) => h.path === rel)).toBe(false);
  });

  test("M3-04 未改文件再 sync → content_hash 跳过，无错误", async () => {
    const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
    const conn = await openPglite(repoRoot);
    try {
      await syncPage(conn.db, repoRoot, rel);
      await syncPage(conn.db, repoRoot, rel);
    } finally {
      await conn.close();
    }
  });

  test("M3-05 entity merge + rebuild → resolve 正确", async () => {
    const queue = await makeQueue();
    const reg = createEntityRegistry(repoRoot, "default", queue);
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
    await reg.create({ slug: "bob", title: "Bob", createdBy: "cli:test" });
    await reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:test" });
    await rebuildIndex(repoRoot);
    const resolved = await reg.resolve("bob");
    expect(resolved.slug).toBe("alice");
  });

  test("M3-06 中文标题「支付网关超时」→ query「网关」能命中（ngram）", async () => {
    const rel = await capture("支付网关超时", "网关 5xx 错误导致订单失败。");
    const hits = await query("网关");
    expect(hits.some((h) => h.path === rel)).toBe(true);
  });

  test("M3-07 capture 后未手工 rebuild → hook 已增量同步可命中", async () => {
    const rel = await capture("重试策略", "网关超时改为固定重试 3 次。");
    const hits = await query("重试策略");
    expect(hits.some((h) => h.path === rel)).toBe(true);
  });

  test("query --source 过滤", async () => {
    const rel = await capture("重试策略", "body");
    const conn = await openPglite(repoRoot);
    try {
      const none = await bm25Query(conn.db, { brainId: "default", query: "重试", sourceId: "nope" });
      expect(none).toHaveLength(0);
      const some = await bm25Query(conn.db, { brainId: "default", query: "重试", sourceId: "default" });
      expect(some.some((h) => h.path === rel)).toBe(true);
    } finally {
      await conn.close();
    }
  });
});
