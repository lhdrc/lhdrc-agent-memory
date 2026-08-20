/**
 * P10.3 — dream phase 4 跨文件 cosine 矛盾可见（B 档）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  runDream,
  captureNode,
  openPglite,
  hybridQuery,
  serializeFrontmatter,
  sha256Hex,
  type EmbeddingProvider,
} from "../src/index.ts";

let dir: string;
let repoRoot: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

const T = { timeout: 60_000 };

async function makeQueue(): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

async function writeSourceWithFacts(
  rel: string,
  facts: Array<{ text: string; event_type?: string; attributed_to?: string; at?: string }>,
  title = "test note",
): Promise<void> {
  const abs = join(repoRoot, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(
    abs,
    serializeFrontmatter(
      {
        title,
        schema_type: "decision",
        source: "default",
        path: rel.replace(/^brains\/default\//, ""),
        created_by: "test",
        status: "active",
        facts,
      },
      "正文",
    ),
    "utf8",
  );
}

class MockEmbedder implements EmbeddingProvider {
  readonly id = "mock";
  readonly dims: number;
  constructor(
    private fn: (texts: string[]) => Promise<number[][]>,
    dims = 4,
  ) {
    this.dims = dims;
  }
  embed(texts: string[]) {
    return this.fn(texts);
  }
}

function nearlyIdenticalEmbedder(): MockEmbedder {
  const base = [1, 0, 0, 0];
  const near = [0.99, 0.01, 0, 0];
  return new MockEmbedder(async (texts) =>
    texts.map((t) => (t.includes("dup") || t.includes("重复") ? [...near] : [...base])),
  );
}

function orthogonalEmbedder(): MockEmbedder {
  return new MockEmbedder(async (texts) =>
    texts.map((_, i) => {
      const v = [0, 0, 0, 0];
      v[i % 4] = 1;
      return v;
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dfmem-p10c-"));
  repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  pack = await loadPack("problem-tree");
});

describe("P10.3 contradictions", () => {
  test(
    "P10C-01 同文件重叠 facts 不同 event_type → intra-file 行",
    async () => {
      const rel = "brains/default/sources/default/issues/general/decisions/intra.md";
      await writeSourceWithFacts(
        rel,
        [
          { text: "支付超时必须重试三次", event_type: "decision", attributed_to: "a", at: "2026-01-01" },
          { text: "支付超时必须重试", event_type: "requirement", attributed_to: "b", at: "2026-01-01" },
        ],
        "冲突事实",
      );

      const queue = await makeQueue();
      const r = await runDream(repoRoot, { brainId: "default", queue, phases: [4] });
      expect(r.phases[0]!.ok).toBe(true);
      expect(r.phases[0]!.details!.findings).toBeGreaterThan(0);

      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).toContain("## intra-file");
      expect(contra).toContain("可能冲突");
      expect(contra).toContain("intra.md");
    },
    T,
  );

  test(
    "P10C-02 mock embedder 近似向量 → cross-file 行；L0 未改",
    async () => {
      const relA = "brains/default/sources/default/issues/general/decisions/cross-a.md";
      const relB = "brains/default/sources/default/issues/general/decisions/cross-b.md";
      const dupText = "dup 支付网关超时固定重试三次";
      await writeSourceWithFacts(relA, [{ text: dupText, event_type: "decision" }], "A");
      await writeSourceWithFacts(relB, [{ text: dupText, event_type: "decision" }], "B");

      const beforeA = sha256Hex(await readFile(join(repoRoot, relA), "utf8"));
      const beforeB = sha256Hex(await readFile(join(repoRoot, relB), "utf8"));

      const queue = await makeQueue();
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
        embedder: nearlyIdenticalEmbedder(),
      });
      expect(r.phases[0]!.ok).toBe(true);
      expect(r.phases[0]!.details!.cross_file).toBeGreaterThan(0);

      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).toContain("## cross-file");
      expect(contra).toContain("duplicate cosine=");
      expect(contra).toContain("cross-a.md");
      expect(contra).toContain("cross-b.md");

      expect(sha256Hex(await readFile(join(repoRoot, relA), "utf8"))).toBe(beforeA);
      expect(sha256Hex(await readFile(join(repoRoot, relB), "utf8"))).toBe(beforeB);
    },
    T,
  );

  test(
    "P10C-03 正交向量 → 无 cross-file",
    async () => {
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/ortho-a.md",
        [{ text: "alpha topic one", event_type: "decision" }],
      );
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/ortho-b.md",
        [{ text: "beta topic two", event_type: "decision" }],
      );

      const queue = await makeQueue();
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
        embedder: orthogonalEmbedder(),
      });
      expect(r.phases[0]!.ok).toBe(true);
      expect(r.phases[0]!.details!.cross_file).toBe(0);

      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).not.toContain("## cross-file");
      expect(contra).toContain("_no contradictions detected_");
    },
    T,
  );

  test(
    "P10C-04 embedding.provider local → 相同文本也不写 cross-file",
    async () => {
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml = yml.replace(/provider:\s*openai/, "provider: local");
      await writeFile(ymlPath, yml, "utf8");

      const sameText = "本地哈希相同文本不应跨文件配对";
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/local-a.md",
        [{ text: sameText, event_type: "decision" }],
      );
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/local-b.md",
        [{ text: sameText, event_type: "requirement" }],
      );

      const queue = await makeQueue();
      const r = await runDream(repoRoot, { brainId: "default", queue, phases: [4] });
      expect(r.phases[0]!.ok).toBe(true);
      expect(r.phases[0]!.details!.cross_file).toBe(0);

      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).not.toContain("## cross-file");
    },
    T,
  );

  test(
    "P10C-05 embed 抛错 → phase ok；文件仍写出",
    async () => {
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/err-a.md",
        [{ text: "err fact a", event_type: "decision" }],
      );
      await writeSourceWithFacts(
        "brains/default/sources/default/issues/general/decisions/err-b.md",
        [{ text: "err fact b", event_type: "decision" }],
      );

      const throwing = new MockEmbedder(async () => {
        throw new Error("embed boom");
      });

      const queue = await makeQueue();
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
        embedder: throwing,
      });
      expect(r.phases[0]!.ok).toBe(true);
      expect(r.phases[0]!.details!.cross_file).toBe(0);

      const contra = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(contra).toContain("# Contradictions");
      expect(contra).not.toContain("duplicate cosine=");
    },
    T,
  );

  test(
    "P10C-06 dream phase 4 后 hybridQuery hit 顺序不变",
    async () => {
      const queue = await makeQueue();
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "decision",
        title: "重试策略 Alpha",
        body: "网关超时改为固定重试 3 次 alpha。",
        createdBy: "test",
      });
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "支付日志 Beta",
        body: "支付日志应保留 30 天 beta。",
        createdBy: "test",
      });

      const queryPaths = async () => {
        const conn = await openPglite(repoRoot);
        try {
          const hits = await hybridQuery(conn.db, {
            brainId: "default",
            query: "重试 支付",
            skipCache: true,
          });
          return hits.map((h) => h.path);
        } finally {
          await conn.close();
        }
      };

      const before = await queryPaths();
      await runDream(repoRoot, { brainId: "default", queue, phases: [4] });
      const after = await queryPaths();
      expect(after).toEqual(before);
    },
    T,
  );

  // P10C-07: phase 4 不调用 complete()；runner 仅 phase 3 经 llm/factory。
  test("P10C-07 phase 4 无 LLM complete 调用", async () => {
    const raw = await readFile(join(import.meta.dir, "../src/dream/runner.ts"), "utf8");
    const start = raw.indexOf("async function phaseContradictions");
    const end = raw.indexOf("async function phaseOrphans");
    expect(start).toBeGreaterThan(0);
    const block = raw.slice(start, end);
    expect(block).not.toContain("complete(");
  });
});
