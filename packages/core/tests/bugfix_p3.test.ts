/**
 * Bugbot P3 修复回归：rebuild 多 brain、orphan 误归档、cache 失效、entity brain 隔离。
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createBrain,
  loadPack,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openPglite,
  rebuildIndex,
  hybridQuery,
  runDream,
  setSearchCache,
  getSearchCache,
  knobsHash,
  syncEntity,
  type SearchKnobs,
} from "../src/index.ts";
import { authorize, assertSourceScope, issueToken, sha256Token, MemoryError, ErrorCodes } from "../src/index.ts";

const T = { timeout: 90_000 };

let dir: string;
let repoRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-bugfix-"));
  repoRoot = await initMemoryRepo(dir, { brain: "brain-a", source: "default", force: false });
});

describe("Bugbot P3 fixes", () => {
  test(
    "rebuildIndex 只清当前 brain，保留其他 brain 索引",
    async () => {
      await createBrain(repoRoot, "brain-b");
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);

      await captureNode(repoRoot, pack, queue, {
        brainId: "brain-a",
        sourceId: "default",
        schemaType: "note",
        title: "NoteA",
        body: "SECRET_A_KEEP",
        createdBy: "t",
      });
      await captureNode(repoRoot, pack, queue, {
        brainId: "brain-b",
        sourceId: "default",
        schemaType: "note",
        title: "NoteB",
        body: "SECRET_B_KEEP",
        createdBy: "t",
      });

      await rebuildIndex(repoRoot, "brain-a");

      const conn = await openPglite(repoRoot);
      try {
        const a = await conn.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM pages WHERE brain_id = 'brain-a'`,
        );
        const b = await conn.db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM pages WHERE brain_id = 'brain-b'`,
        );
        expect(Number(a.rows[0]?.n ?? 0)).toBeGreaterThan(0);
        expect(Number(b.rows[0]?.n ?? 0)).toBeGreaterThan(0);

        const hitsB = await hybridQuery(conn.db, {
          brainId: "brain-b",
          query: "SECRET_B_KEEP",
          skipCache: true,
        });
        expect(hitsB.length).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "dream orphans 不归档普通 note；只归档 temporary",
    async () => {
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);

      const normal = await captureNode(repoRoot, pack, queue, {
        brainId: "brain-a",
        sourceId: "default",
        schemaType: "note",
        title: "普通笔记",
        body: "无链接也保留",
        createdBy: "t",
      });

      const tempRel = await captureNode(repoRoot, pack, queue, {
        brainId: "brain-a",
        sourceId: "default",
        schemaType: "note",
        title: "临时草稿",
        body: "应被归档",
        createdBy: "t",
      });
      // 打 temporary 标记
      const abs = join(repoRoot, tempRel);
      let raw = await readFile(abs, "utf8");
      raw = raw.replace(/^---\n/, "---\ntemporary: true\n");
      await writeFile(abs, raw, "utf8");
      // 触发索引刷新
      await queue.execute(async () => [tempRel], "mark temporary");

      await runDream(repoRoot, { brainId: "brain-a", queue, phases: [5] });

      const normalFm = await readFile(join(repoRoot, normal), "utf8");
      expect(normalFm).toMatch(/status:\s*active/);
      expect(normalFm).not.toMatch(/status:\s*archived/);

      const tempFm = await readFile(abs, "utf8");
      expect(tempFm).toMatch(/status:\s*archived/);
    },
    T,
  );

  test("受限 token 对未授权 source 触发 E_FORBIDDEN", () => {
    const issued = issueToken("alice", "brain-a");
    const authCfg = {
      users: [
        {
          id: "alice",
          role: "member" as const,
          brains: { "brain-a": { role: "member" as const, sources: ["app"] } },
        },
      ],
      tokens: [{ id: issued.id, user: "alice", hash: `sha256:${sha256Token(issued.raw)}`, brain: "brain-a" }],
    };
    const ctx = authorize(
      { channel: "remote", token: issued.raw, brainId: "brain-a", sourceId: "app" },
      authCfg,
    );
    expect(() => assertSourceScope(ctx, "ops")).toThrow(MemoryError);
    try {
      assertSourceScope(ctx, "ops");
    } catch (e) {
      expect((e as MemoryError).code).toBe(ErrorCodes.FORBIDDEN);
    }
  });

  test(
    "写文件后 search_cache 失效",
    async () => {
      const pack = await loadPack("problem-tree");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      await captureNode(repoRoot, pack, queue, {
        brainId: "brain-a",
        sourceId: "default",
        schemaType: "note",
        title: "缓存页",
        body: "cache-body-v1",
        createdBy: "t",
      });

      const knobs: SearchKnobs = {
        mode: "balanced",
        brainId: "brain-a",
        intent: "general",
        weightsKey: "w",
        limit: 10,
        semanticAvailable: false,
      };
      const conn = await openPglite(repoRoot);
      try {
        await setSearchCache(conn.db, "cache-body", knobs, [
          { path: "x.md", title: "old", score: 1, snippet: "stale", evidence: [] },
        ]);
        expect(await getSearchCache(conn.db, "cache-body", knobs)).not.toBeNull();
      } finally {
        await conn.close();
      }

      await captureNode(repoRoot, pack, queue, {
        brainId: "brain-a",
        sourceId: "default",
        schemaType: "note",
        title: "触发失效",
        body: "invalidate",
        createdBy: "t",
      });

      const conn2 = await openPglite(repoRoot);
      try {
        expect(await getSearchCache(conn2.db, "cache-body", knobs)).toBeNull();
      } finally {
        await conn2.close();
      }
    },
    T,
  );

  test(
    "entity_registry 按 brain_id 隔离同 slug",
    async () => {
      await createBrain(repoRoot, "brain-b");
      const { createEntityRegistry } = await import("../src/index.ts");
      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);

      const regA = createEntityRegistry(repoRoot, "brain-a", queue);
      const regB = createEntityRegistry(repoRoot, "brain-b", queue);
      await regA.create({ slug: "alice", title: "Alice-A", createdBy: "test" });
      await regB.create({ slug: "alice", title: "Alice-B", createdBy: "test" });

      const conn = await openPglite(repoRoot);
      try {
        await syncEntity(conn.db, repoRoot, "brains/brain-a/entities/alice.md");
        await syncEntity(conn.db, repoRoot, "brains/brain-b/entities/alice.md");
        const rows = await conn.db.query<{ brain_id: string; title: string }>(
          `SELECT brain_id, title FROM entity_registry WHERE slug = 'alice' ORDER BY brain_id`,
        );
        expect(rows.rows.length).toBe(2);
        expect(rows.rows.map((r) => r.brain_id).sort()).toEqual(["brain-a", "brain-b"]);
        expect(rows.rows.find((r) => r.brain_id === "brain-a")?.title).toBe("Alice-A");
        expect(rows.rows.find((r) => r.brain_id === "brain-b")?.title).toBe("Alice-B");
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("knobsHash 含 semanticAvailable 区分", () => {
    const base: SearchKnobs = {
      mode: "balanced",
      brainId: "default",
      intent: "general",
      weightsKey: "w",
      limit: 10,
      semanticAvailable: true,
    };
    expect(knobsHash(base)).not.toBe(knobsHash({ ...base, semanticAvailable: false }));
  });
});
