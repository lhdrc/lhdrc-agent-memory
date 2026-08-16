/**
 * P9.1 content_hash 语义归一化：时间戳不进 hash，语义变才重切块。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  syncPage,
  semanticContentHash,
  serializeFrontmatter,
} from "../src/index.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";

const T = { timeout: 120_000 };

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p91-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

function pageMd(overrides: Record<string, unknown> = {}, body = "## 摘要\n\n固定重试 3 次。\n\n## 正文\n固定重试 3 次。"): string {
  return serializeFrontmatter(
    {
      title: "重试策略",
      schema_type: "decision",
      status: "active",
      source: "default",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: "cli:test",
      facts: [{ text: "重试改为 3 次", event_type: "decision", attributed_to: "user", at: "2026-01-01" }],
      ...overrides,
    },
    body,
  );
}

async function chunkSnapshot(rel: string): Promise<{ hash: string; updatedAt: string; chunks: string[] }> {
  const conn = await openPglite(repoRoot);
  try {
    const page = await conn.db.query<{ content_hash: string; updated_at: string }>(
      `SELECT content_hash, updated_at FROM pages WHERE path = $1`,
      [rel],
    );
    const chunks = await conn.db.query<{ text: string }>(
      `SELECT text FROM chunks WHERE path = $1 ORDER BY chunk_index`,
      [rel],
    );
    return {
      hash: page.rows[0]!.content_hash,
      updatedAt: page.rows[0]!.updated_at,
      chunks: chunks.rows.map((r) => r.text),
    };
  } finally {
    await conn.close();
  }
}

describe("P9.1 semantic content_hash", () => {
  test("P91-01 仅 created_at 不同 → hash 相等；第二次 sync 不重写 chunks", async () => {
    const a = pageMd({ created_at: "2026-01-01T00:00:00.000Z" });
    const b = pageMd({ created_at: "2026-08-16T12:00:00.000Z" });
    expect(semanticContentHash(a)).toBe(semanticContentHash(b));

    const queue = await makeQueue();
    const rel = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    const before = await chunkSnapshot(rel);
    const abs = join(repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const mutated = raw.replace(/created_at:\s*.+/u, 'created_at: "2099-01-01T00:00:00.000Z"');
    expect(mutated).not.toBe(raw);
    expect(semanticContentHash(mutated)).toBe(semanticContentHash(raw));
    await writeFile(abs, mutated, "utf8");
    const conn = await openPglite(repoRoot);
    try {
      await syncPage(conn.db, repoRoot, rel);
    } finally {
      await conn.close();
    }
    const after = await chunkSnapshot(rel);
    expect(after.hash).toBe(before.hash);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.chunks).toEqual(before.chunks);
  }, T);

  test("P91-02 只改 body 一字 → hash 变；chunks 更新", async () => {
    const queue = await makeQueue();
    const rel = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    const before = await chunkSnapshot(rel);
    const abs = join(repoRoot, rel);
    const parsed = parseFrontmatter(await readFile(abs, "utf8"));
    const nextBody = parsed.body.replace("3 次", "4 次");
    expect(nextBody).not.toBe(parsed.body);
    await writeFile(abs, serializeFrontmatter(parsed.data, nextBody), "utf8");
    expect(semanticContentHash(await readFile(abs, "utf8"))).not.toBe(before.hash);
    const conn = await openPglite(repoRoot);
    try {
      await syncPage(conn.db, repoRoot, rel);
    } finally {
      await conn.close();
    }
    const after = await chunkSnapshot(rel);
    expect(after.hash).not.toBe(before.hash);
    expect(after.chunks.join("")).toContain("4 次");
  }, T);

  test("P91-03 只改 facts[].text → hash 变", async () => {
    const a = pageMd();
    const facts = [{ text: "重试改为 5 次", event_type: "decision", attributed_to: "user", at: "2026-01-01" }];
    const b = pageMd({ facts });
    expect(semanticContentHash(a)).not.toBe(semanticContentHash(b));

    const queue = await makeQueue();
    const rel = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      facts: [{ text: "重试改为 3 次", event_type: "decision", attributed_to: "user", at: "2026-01-01" }],
      createdBy: "cli:test",
    });
    const before = await chunkSnapshot(rel);
    const abs = join(repoRoot, rel);
    const parsed = parseFrontmatter(await readFile(abs, "utf8"));
    const nextFacts = Array.isArray(parsed.data.facts)
      ? (parsed.data.facts as Array<Record<string, unknown>>).map((f, i) =>
          i === 0 ? { ...f, text: "重试改为 9 次" } : f,
        )
      : [];
    parsed.data.facts = nextFacts;
    await writeFile(abs, serializeFrontmatter(parsed.data, parsed.body), "utf8");
    const conn = await openPglite(repoRoot);
    try {
      await syncPage(conn.db, repoRoot, rel);
    } finally {
      await conn.close();
    }
    const after = await chunkSnapshot(rel);
    expect(after.hash).not.toBe(before.hash);
  }, T);

  test("P91-04 只改 updated_at → hash 不变", () => {
    const a = pageMd({ updated_at: "2026-01-01T00:00:00.000Z" });
    const b = pageMd({ updated_at: "2026-12-31T23:59:59.000Z" });
    expect(semanticContentHash(a)).toBe(semanticContentHash(b));
  });

  test("P91-05 未改文件再 sync → hash 跳过仍绿", async () => {
    const queue = await makeQueue();
    const rel = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "decision",
      title: "重试策略",
      body: "网关超时改为固定重试 3 次。",
      createdBy: "cli:test",
    });
    const before = await chunkSnapshot(rel);
    const conn = await openPglite(repoRoot);
    try {
      await syncPage(conn.db, repoRoot, rel);
      await syncPage(conn.db, repoRoot, rel);
    } finally {
      await conn.close();
    }
    const after = await chunkSnapshot(rel);
    expect(after.hash).toBe(before.hash);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.chunks).toEqual(before.chunks);
  }, T);
});
