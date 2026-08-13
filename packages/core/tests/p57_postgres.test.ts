/**
 * P5.7 PostgresEngine：默认 pglite 不变；postgres 需 DSN；坏 DSN / 缺 URL → E_INDEX。
 * P57-02/03 在无 DF_MEMORY_DATABASE_URL 时 skip（口令保留）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  openIndex,
  hybridQuery,
  rebuildIndex,
  MemoryError,
  ErrorCodes,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const repoSrc = join(import.meta.dir, "../../..");

const liveUrl = process.env.DF_MEMORY_DATABASE_URL?.trim();
const liveOn = Boolean(liveUrl && /^postgres(ql)?:\/\//i.test(liveUrl));
const live = liveOn ? describe : describe.skip;

async function patchEngine(repoRoot: string, engine: string): Promise<void> {
  const p = join(repoRoot, "memory.yml");
  const yml = await readFile(p, "utf8");
  await writeFile(p, yml.replace(/engine:\s*pglite/, `engine: ${engine}`), "utf8");
}

function withEnv(patch: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("P5.7 postgres engine (always)", () => {
  test("P57-01: 默认 pglite，不改配置可 capture+query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p57-def-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const cfg = await loadRepoConfig(repoRoot);
    expect(cfg.index.engine).toBe("pglite");
    const pack = await loadPack("problem-tree");
    const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
    const path = await captureNode(repoRoot, pack, queue, {
      brainId: "default",
      sourceId: "default",
      schemaType: "note",
      title: "P57默认重试",
      body: "固定三次重试 P57DEFAULTTOKEN",
      createdBy: "p57",
    });
    const conn = await openIndex(repoRoot);
    try {
      expect(conn.engine).toBe("pglite");
      const hits = await hybridQuery(conn.db, { brainId: "default", query: "P57DEFAULTTOKEN", skipCache: true });
      expect(hits.some((h) => h.path === path)).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P57-05: engine=postgres 未设 URL → E_INDEX 且提示 DF_MEMORY_DATABASE_URL", async () => {
    const restore = withEnv({ DF_MEMORY_DATABASE_URL: undefined });
    try {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p57-nourl-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchEngine(repoRoot, "postgres");
      let err: unknown;
      try {
        await openIndex(repoRoot);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).code).toBe(ErrorCodes.INDEX);
      expect((err as MemoryError).message).toMatch(/DF_MEMORY_DATABASE_URL/);
    } finally {
      restore();
    }
  }, T);

  test("P57-04: 坏 DSN → E_INDEX；capture 已写 md 仍在（D1）", async () => {
    const restore = withEnv({
      DF_MEMORY_DATABASE_URL: "postgres://nope:nope@127.0.0.1:1/none",
    });
    try {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p57-baddsn-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchEngine(repoRoot, "postgres");
      const cfg = await loadRepoConfig(repoRoot);
      const pack = await loadPack("problem-tree");
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      const rel = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "P57坏DSN",
        body: "md must survive index failure",
        createdBy: "p57",
      });
      expect(existsSync(join(repoRoot, rel))).toBe(true);

      let err: unknown;
      try {
        await openIndex(repoRoot);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).code).toBe(ErrorCodes.INDEX);
      expect((err as MemoryError).message).toMatch(/E_INDEX|Postgres|连接|DF_MEMORY_DATABASE_URL|无效/i);
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    } finally {
      restore();
    }
  }, T);

  test("P57-06: compose + README 步骤存在", () => {
    expect(existsSync(join(repoSrc, "scripts/docker-compose.postgres.yml"))).toBe(true);
    expect(existsSync(join(repoSrc, "scripts/dev-postgres.md"))).toBe(true);
  });
});

live("P5.7 postgres live (P57-02/03)", () => {
  let schema = "";
  let restoreSchema: () => void = () => {};

  afterEach(() => {
    restoreSchema();
  });

  test(
    "P57-02: engine=postgres capture → query 命中 path",
    async () => {
      schema = `dfmem_p57_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      restoreSchema = withEnv({ DF_MEMORY_PG_SCHEMA: schema });
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p57-live-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchEngine(repoRoot, "postgres");
      const cfg = await loadRepoConfig(repoRoot);
      expect(cfg.index.engine).toBe("postgres");
      const pack = await loadPack("problem-tree");
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "重试策略",
        body: "改为固定3次 P57PGTOKEN",
        createdBy: "p57",
      });
      const conn = await openIndex(repoRoot);
      try {
        expect(conn.engine).toBe("postgres");
        const hits = await hybridQuery(conn.db, { brainId: "default", query: "P57PGTOKEN", skipCache: true });
        expect(hits.some((h) => h.path === path)).toBe(true);
      } finally {
        await conn.close();
      }

      const proc = Bun.spawn({
        cmd: [bunBin, cliMain, "query", "P57PGTOKEN"],
        cwd: repoRoot,
        env: { ...process.env, DF_MEMORY_ROOT: repoRoot, DF_MEMORY_PG_SCHEMA: schema },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, , exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(out).toContain(path.replace(/\\/g, "/").split("/").pop() ?? path);
    },
    T,
  );

  test(
    "P57-03: drop 表后 rebuild-index → query 再命中同一 path",
    async () => {
      schema = `dfmem_p57r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      restoreSchema = withEnv({ DF_MEMORY_PG_SCHEMA: schema });
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p57-reb-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchEngine(repoRoot, "postgres");
      const cfg = await loadRepoConfig(repoRoot);
      const pack = await loadPack("problem-tree");
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "rebuild note",
        body: "P57REBUILDTOKEN survives drop",
        createdBy: "p57",
      });

      const conn = await openIndex(repoRoot);
      try {
        await conn.db.exec(
          `DROP TABLE IF EXISTS chunks CASCADE; DROP TABLE IF EXISTS pages CASCADE; DROP TABLE IF EXISTS links CASCADE; DROP TABLE IF EXISTS entity_registry CASCADE; DROP TABLE IF EXISTS search_cache CASCADE;`,
        );
      } finally {
        await conn.close();
      }

      await rebuildIndex(repoRoot, "default");
      const conn2 = await openIndex(repoRoot);
      try {
        const hits = await hybridQuery(conn2.db, { brainId: "default", query: "P57REBUILDTOKEN", skipCache: true });
        expect(hits.some((h) => h.path === path)).toBe(true);
      } finally {
        await conn2.close();
      }
    },
    T,
  );
});
