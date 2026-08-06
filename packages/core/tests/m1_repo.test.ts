import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createEntityRegistry,
  normalizeRepoPath,
  ErrorCodes,
  parseFrontmatter,
  gitLog,
} from "../src/index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-m1-"));
});

async function initDir(): Promise<string> {
  return initMemoryRepo(dir, { brain: "default", source: "default", force: false });
}

describe("M1 仓库与文件权威", () => {
  test("M1-01 init 创建完整仓布局与首 commit", async () => {
    const root = await initDir();
    const entries = [
      "memory.yml",
      ".gitignore",
      ".dfmemory/index-meta.json",
      "brains/default/brain.yml",
      "brains/default/sources/default/.dfmemory-source",
      "brains/default/sources/default/issues",
      "brains/default/entities",
      "brains/default/events",
      "brains/default/experiences",
      "brains/default/skills",
      "brains/default/contradictions.md",
    ];
    for (const rel of entries) {
      const err = await stat(join(root, rel)).then(() => null).catch((e) => e);
      expect(err, `缺失 ${rel}`).toBeNull();
    }
    const logs = await gitLog(root, 1);
    expect(logs[0]).toBe("memory: init brain default");
  });

  test("M1-02 已 init 再 init 无 force → E_USAGE", async () => {
    await initDir();
    expect(initMemoryRepo(dir, { brain: "default", source: "default", force: false })).rejects.toMatchObject({
      code: ErrorCodes.USAGE,
    });
  });

  test("M1-03 entity create 生成 active 实体文件", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    const e = await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    expect(e.status).toBe("active");
    const raw = await readFile(join(root, "brains", "default", "entities", "alice.md"), "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data.status).toBe("active");
    expect(data.slug).toBe("alice");
  });

  test("M1-04 resolve 精确匹配 slug", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", aliases: ["Alice Zhang"], createdBy: "cli:user" });
    const e = await reg.resolve("alice");
    expect(e.slug).toBe("alice");
    expect(e.title).toBe("Alice");
  });

  test("M1-05 merge 文件事务: loser 变 redirect stub, ledger 有事件", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    await reg.create({ slug: "bob", title: "Bob", aliases: ["Bobby"], createdBy: "cli:user" });
    await reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:user" });

    const bobRaw = await readFile(join(root, "brains", "default", "entities", "bob.md"), "utf8");
    const bob = parseFrontmatter(bobRaw).data;
    expect(bob.status).toBe("merged");
    expect(bob.redirect).toBe("alice");

    const events = await readDirRecursive(root, "brains/default/events");
    const ledgerFiles = events.filter((p) => p.endsWith("ledger.jsonl"));
    expect(ledgerFiles.length).toBeGreaterThan(0);
    const ledgerRaw = await readFile(join(root, ledgerFiles[0]!), "utf8");
    const line = JSON.parse(ledgerRaw.trim().split("\n").at(-1)!);
    expect(line.type).toBe("entity_merged");
    expect(line.from).toContain("bob");
    expect(line.to).toBe("alice");
  });

  test("M1-06 merge 后 resolve loser → canonical", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    await reg.create({ slug: "bob", title: "Bob", createdBy: "cli:user" });
    await reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:user" });
    const resolved = await reg.resolve("bob");
    expect(resolved.slug).toBe("alice");
  });

  test("M1-07 删除 .dfmemory 后仍可从文件 resolve（文件权威）", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    await reg.create({ slug: "bob", title: "Bob", createdBy: "cli:user" });
    await reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:user" });
    await rm(join(root, ".dfmemory"), { recursive: true, force: true });
    const reg2 = createEntityRegistry(root, "default");
    const resolved = await reg2.resolve("bob");
    expect(resolved.slug).toBe("alice");
  });

  test("M1-08 normalizeRepoPath 含 .. 抛 E_PATH_ESCAPE", async () => {
    const root = await initDir();
    expect(() =>
      normalizeRepoPath(root, "default", "sources/default/../../etc/passwd"),
    ).toThrow(expect.objectContaining({ code: ErrorCodes.PATH_ESCAPE }));
    expect(() => normalizeRepoPath(root, "default", "/abs/path")).toThrow(
      expect.objectContaining({ code: ErrorCodes.PATH_ESCAPE }),
    );
  });

  test("M1-09 merge 无 --confirm → E_CONFLICT", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    await reg.create({ slug: "bob", title: "Bob", createdBy: "cli:user" });
    const p = reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: false, mergedBy: "cli:user" });
    await expect(p).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  });

  test("entity list 默认过滤 merged", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:user" });
    await reg.create({ slug: "bob", title: "Bob", createdBy: "cli:user" });
    await reg.merge({ entityIds: ["alice", "bob"], canonical: "alice", confirm: true, mergedBy: "cli:user" });
    expect((await reg.list()).map((e) => e.slug)).toEqual(["alice"]);
    expect((await reg.list({ includeMerged: true })).map((e) => e.slug)).toEqual(["alice", "bob"]);
  });

  test("resolve 可通过 alias 命中", async () => {
    const root = await initDir();
    const reg = createEntityRegistry(root, "default");
    await reg.create({ slug: "alice", title: "Alice", aliases: ["A Zhang"], createdBy: "cli:user" });
    const e = await reg.resolve("A Zhang");
    expect(e.slug).toBe("alice");
  });

  test("schema pack 可加载，类型列表含 requirement/decision/lesson/note", async () => {
    const { loadPack } = await import("../src/schema/loadPack.ts");
    const pack = await loadPack("problem-tree");
    for (const t of ["requirement", "decision", "lesson", "note"]) {
      expect(pack.schema_types).toContain(t);
    }
  });
});

async function readDirRecursive(root: string, rel: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const base = join(root, rel);
  const out: string[] = [];
  const entries = await readdir(base);
  for (const e of entries) {
    const p = join(base, e);
    const s = await stat(p);
    if (s.isDirectory()) {
      out.push(...(await readDirRecursive(root, join(rel, e))));
    } else {
      out.push(join(rel, e));
    }
  }
  return out;
}
