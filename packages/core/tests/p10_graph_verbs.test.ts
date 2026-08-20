/**
 * P10.2 图谱规则密度：扩动词 / 种子门控 / 查询防御
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  openPglite,
  hybridQueryDetailed,
  parseRelationalQuery,
  graphArmDetailed,
  extractEntityRefs,
  compileExtraVerbs,
  KNOWN_LINK_TYPES,
  DEFAULT_VERBS,
  needleMatchesQuery,
  createEntityRegistry,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 30_000 };

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

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p10-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  await patchMemoryYml(repoRoot, { embedding: { provider: "local" } });
  pack = await loadPack("problem-tree");
});

describe("P10.2 graph verbs + seed gating", () => {
  test(
    "P10G-01: works_at from Alice works at @rivermark",
    async () => {
      const rel = await capture("Alice at Rivermark", "Alice works at @rivermark");
      const conn = await openPglite(repoRoot);
      try {
        const r = await conn.db.query<{ to_ref: string; type: string }>(
          `SELECT to_ref, type FROM links WHERE from_path = $1`,
          [rel],
        );
        expect(r.rows.some((row) => row.to_ref === "rivermark" && row.type === "works_at")).toBe(true);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("P10G-02: invalid extra_verbs type ignored; 决定 still decided", () => {
    const extra = compileExtraVerbs([
      { pattern: "胡编|bogus", type: "not_a_type" },
      { pattern: "带队|led", type: "works_on" },
    ]);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.type).toBe("works_on");

    const verbs = [...DEFAULT_VERBS, ...extra];
    const links = extractEntityRefs("我们决定重试 [[policy]]", undefined, { verbPatterns: verbs });
    expect(links.some((l) => l.to === "policy" && l.type === "decided")).toBe(true);
  });

  test(
    "P10G-03: stopword queries do not throw; graph arm empty",
    async () => {
      await capture("普通笔记", "没有任何关系模板的正文内容。");
      const conn = await openPglite(repoRoot);
      try {
        for (const q of ["the", "的"]) {
          const { hits, explain } = await hybridQueryDetailed(conn.db, {
            brainId: "default",
            query: q,
            repoRoot,
            explain: true,
            skipCache: true,
          });
          expect(Array.isArray(hits)).toBe(true);
          expect(explain!.arms.graph).toEqual([]);
          const arm = await graphArmDetailed(conn.db, { brainId: "default", query: q });
          expect(arm.hits).toEqual([]);
          expect(arm.mode).toBe("empty");
        }
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P10G-04: 2-letter slug al not adjacency seed in longer words",
    async () => {
      const queue = await makeQueue();
      const reg = createEntityRegistry(repoRoot, "default", queue);
      await reg.create({ slug: "al", title: "Al", createdBy: "cli:test" });
      await capture("支付通道", "total payment channel configuration notes.");

      expect(needleMatchesQuery("total payment channel", "al")).toBe(false);

      const conn = await openPglite(repoRoot);
      try {
        const arm = await graphArmDetailed(conn.db, {
          brainId: "default",
          query: "total payment channel configuration",
        });
        expect(arm.mode).toBe("empty");
        expect(arm.hits).toEqual([]);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P10G-05: 谁负责支付 relational graph arm non-empty",
    async () => {
      expect(parseRelationalQuery("谁负责支付")).toEqual({ seed: "支付", verb: "works_on" });

      await capture("支付负责人", "Alice 负责 @支付 模块对接与验收。");
      const conn = await openPglite(repoRoot);
      try {
        const { explain } = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "谁负责支付",
          repoRoot,
          explain: true,
          skipCache: true,
        });
        expect(explain!.arms.graph.length).toBeGreaterThanOrEqual(1);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test("P10G-06: dangerous extra_verbs dropped; loadPack does not throw", async () => {
    const extra = compileExtraVerbs([
      { pattern: "(?=(foo))bad", type: "works_on" },
      { pattern: "x{33,}", type: "decided" },
      { pattern: "合法|ok", type: "decided" },
    ]);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.type).toBe("decided");

    const packDir = await mkdtemp(join(tmpdir(), "dfmem-pack-"));
    const packPath = join(packDir, "bad-extra.yml");
    await writeFile(
      packPath,
      `id: bad-extra
version: 1
schema_types:
  - note
merge_op:
  note: patch
filename_templates:
  note: "notes/{slug}.md"
n_start: 1
extra_verbs:
  - pattern: "(?=(evil))"
    type: works_on
  - pattern: "a{33,}"
    type: decided
  - pattern: "not_a_type_pat"
    type: totally_unknown
`,
      "utf8",
    );
    const loaded = await loadPack(packPath);
    expect(loaded.extra_verbs?.length).toBe(3);
    expect(compileExtraVerbs(loaded.extra_verbs)).toEqual([]);
  });

  test("KNOWN_LINK_TYPES frozen set locked", () => {
    expect(KNOWN_LINK_TYPES.size).toBe(10);
    expect([...KNOWN_LINK_TYPES].sort()).toEqual([
      "advises",
      "belongs_to",
      "decided",
      "founded",
      "invested_in",
      "mentions",
      "produced_by",
      "references",
      "works_at",
      "works_on",
    ]);
  });

  test("parseRelationalQuery english who works at / who founded", () => {
    expect(parseRelationalQuery("who works at Rivermark")).toEqual({
      seed: "Rivermark",
      verb: "works_at",
    });
    expect(parseRelationalQuery("who founded Acme")).toEqual({
      seed: "Acme",
      verb: "founded",
    });
  });

  test("parseRelationalQuery rejects stopword seed and seed > 64", () => {
    expect(parseRelationalQuery("提到了 the")).toBeNull();
    expect(parseRelationalQuery(`提到了 ${"x".repeat(65)}`)).toBeNull();
  });
});
