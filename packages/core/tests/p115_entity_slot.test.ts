/**
 * P11.5 实体槽位 patch（当前值投影）
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  createEntityRegistry,
  sameEntitySlot,
  sha256Hex,
  MemoryError,
  type SchemaPack,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const NY = "Alice lives in New York";
const SF = "Alice lives in San Francisco";
const WORK = "Alice works at Acme";

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p115-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  const reg = createEntityRegistry(repoRoot, "default", queue);
  return { repoRoot, pack, queue, reg };
}

async function hashSources(repoRoot: string): Promise<string> {
  const root = join(repoRoot, "brains", "default", "sources");
  const files: string[] = [];
  async function walk(abs: string, rel: string) {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const child = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child, childRel);
      else if (e.isFile()) files.push(childRel);
    }
  }
  await walk(root, "");
  files.sort();
  const parts: string[] = [];
  for (const rel of files) {
    parts.push(rel, await readFile(join(root, rel), "utf8"));
  }
  return sha256Hex(parts.join("\n"));
}

describe("P11.5 entity slot", () => {
  test("sameEntitySlot: 居住地更新 vs 任职", () => {
    expect(sameEntitySlot(NY, SF)).toBe(true);
    expect(sameEntitySlot(NY, WORK)).toBe(false);
    expect(sameEntitySlot(NY, NY)).toBe(false);
  });

  test(
    "P115-01: NY 再 SF → facts.length 仍 1，text 含 San Francisco",
    async () => {
      const { reg } = await boot();
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      const a = await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      expect(a.patched).toBe(false);
      expect(a.facts?.length).toBe(1);
      const b = await reg.linkFacts({ slug: "alice", fact: SF, by: "cli:test" });
      expect(b.patched).toBe(true);
      expect(b.facts?.length).toBe(1);
      expect(b.facts?.[0]?.text).toContain("San Francisco");
    },
    T,
  );

  test(
    "P115-02: NY 后再 works at Acme → facts.length=2",
    async () => {
      const { reg } = await boot();
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      const b = await reg.linkFacts({ slug: "alice", fact: WORK, by: "cli:test" });
      expect(b.patched).toBe(false);
      expect(b.facts?.length).toBe(2);
    },
    T,
  );

  test(
    "P115-03: 相同 text 再 link → 条数不变",
    async () => {
      const { reg } = await boot();
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      const b = await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      expect(b.patched).toBe(false);
      expect(b.facts?.length).toBe(1);
    },
    T,
  );

  test(
    "P115-04: merge_op.entity: immutable → 两次居住地 length=2",
    async () => {
      const { repoRoot, pack } = await boot();
      const immutable: SchemaPack = {
        ...pack,
        id: "immutable-entity",
        merge_op: { ...pack.merge_op, entity: "immutable" },
      };
      const packPath = join(repoRoot, "immutable-entity.yml");
      await writeFile(packPath, stringifyYaml(immutable), "utf8");
      const ymlPath = join(repoRoot, "memory.yml");
      const yml = (parseYaml(await readFile(ymlPath, "utf8")) ?? {}) as Record<string, unknown>;
      yml.schema_pack = packPath;
      await writeFile(ymlPath, stringifyYaml(yml), "utf8");

      const cfg = await loadRepoConfig(repoRoot);
      const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      const b = await reg.linkFacts({ slug: "alice", fact: SF, by: "cli:test" });
      expect(b.patched).toBe(false);
      expect(b.facts?.length).toBe(2);
    },
    T,
  );

  test(
    "P115-05: capture 已有 note 不因 note: patch 被改写",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      expect(pack.merge_op.note).toBe("patch");
      expect(pack.merge_op.entity).toBe("patch");
      const path1 = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Dup note title",
        body: "FIRST_NOTE_BODY_KEEP",
        createdBy: "cli:test",
      });
      const hashBefore = sha256Hex(await readFile(join(repoRoot, path1), "utf8"));
      await expect(
        captureNode(repoRoot, pack, queue, {
          brainId: "default",
          sourceId: "default",
          schemaType: "note",
          title: "Dup note title",
          body: "SECOND_NOTE_BODY_MUST_NOT_APPEAR",
          createdBy: "cli:test",
        }),
      ).rejects.toBeInstanceOf(MemoryError);
      const hashAfter = sha256Hex(await readFile(join(repoRoot, path1), "utf8"));
      expect(hashAfter).toBe(hashBefore);
      const raw = await readFile(join(repoRoot, path1), "utf8");
      expect(raw).toContain("FIRST_NOTE_BODY_KEEP");
      expect(raw).not.toContain("SECOND_NOTE_BODY_MUST_NOT_APPEAR");
    },
    T,
  );

  test(
    "P115-06: 实体 md 外的 sources/ 文件内容哈希不变",
    async () => {
      const { repoRoot, pack, queue, reg } = await boot();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "L0 stays",
        body: "source body must not change",
        createdBy: "cli:test",
      });
      const before = await hashSources(repoRoot);
      await mkdir(join(repoRoot, "brains", "default", "entities"), { recursive: true });
      await reg.create({ slug: "alice", title: "Alice", createdBy: "cli:test" });
      await reg.linkFacts({ slug: "alice", fact: NY, by: "cli:test" });
      await reg.linkFacts({ slug: "alice", fact: SF, by: "cli:test" });
      const after = await hashSources(repoRoot);
      expect(after).toBe(before);
    },
    T,
  );
});
