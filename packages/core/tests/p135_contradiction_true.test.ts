import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  WriteQueue,
  pgliteIndexHooks,
  runDream,
  serializeFrontmatter,
  type EmbeddingProvider,
} from "../src/index.ts";
import { loadPack } from "../src/schema/loadPack.ts";

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
  facts: Array<{ text: string; event_type?: string }>,
) {
  const abs = join(repoRoot, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(
    abs,
    serializeFrontmatter(
      {
        title: "test",
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
  readonly dims = 4;
  constructor(private fn: (texts: string[]) => Promise<number[][]>) {}
  embed(texts: string[]) {
    return this.fn(texts);
  }
}

function highSimValueConflictEmbedder(): MockEmbedder {
  // NY vs SF: near identical vectors (cosine 0.99) but value tokens differ
  return new MockEmbedder(async (texts) =>
    texts.map((t) => {
      if (t.includes("NY") || t.includes("SF")) return [0.99, 0.01, 0, 0];
      if (t.includes("100") || t.includes("200")) return [0.99, 0.02, 0, 0];
      return [1, 0, 0, 0];
    }),
  );
}

function grayAreaEmbedder(): MockEmbedder {
  // cosine 0.93 for any pair
  return new MockEmbedder(async (texts) => texts.map(() => [0.93, 0.07, 0, 0]));
}

describe("P13.5 真矛盾标记", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dfmem-p135-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    pack = await loadPack("problem-tree");
  });

  test(
    "P135-01 同实体异值 NY vs SF 标 contradiction 非 duplicate",
    async () => {
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/a.md", [
        { text: "Alice 住在 NY", event_type: "fact" },
      ]);
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/b.md", [
        { text: "Alice 住在 SF", event_type: "fact" },
      ]);
      const queue = await makeQueue();
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
        embedder: highSimValueConflictEmbedder(),
      } as unknown as { brainId: string; queue: WriteQueue; phases: [4]; embedder: EmbeddingProvider });
      const md = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      // 真矛盾应标 supersede（值冲突）而非仅 duplicate，且含值
      expect(md.toLowerCase()).toMatch(/supersede/);
      expect(md).toContain("NY");
      expect(md).toContain("SF");
    },
    T,
  );

  test(
    "P135-02 local 档走规则分支不进 LLM",
    async () => {
      const ymlPath = join(repoRoot, "memory.yml");
      let yml = await readFile(ymlPath, "utf8");
      yml = yml.replace(/provider:\s*openai/, "provider: local");
      await writeFile(ymlPath, yml, "utf8");
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/a2.md", [
        { text: "Alice 住在 NY", event_type: "fact" },
      ]);
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/b2.md", [
        { text: "Alice 住在 SF", event_type: "fact" },
      ]);
      const queue = await makeQueue();
      // local 下即使提供 mock LLM 也不应被调用，dream 仍应通过规则标出
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
      });
      expect(r.phases[0]!.ok).toBe(true);
      // 无 LLM 抛错，文件仍写出
      const md = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      expect(md).toContain("# Contradictions");
    },
    T,
  );

  test(
    "P135-03 灰区批量 LLM 后 contradictions.md 含 supersede",
    async () => {
      // 需 mock LLM：若实现未接 LLM，此测试 via 灰区 embed + mock complete 应产生 supersede
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/c.md", [
        { text: "配额 100", event_type: "fact" },
      ]);
      await writeSourceWithFacts("brains/default/sources/default/issues/general/decisions/d.md", [
        { text: "配额 200", event_type: "fact" },
      ]);
      const queue = await makeQueue();
      // 若未实现 LLM 灰区，此测试预期在实现后才含 supersede；现阶段先验 P10.3 的 cross-file 至少有 duplicate
      const r = await runDream(repoRoot, {
        brainId: "default",
        queue,
        phases: [4],
        embedder: grayAreaEmbedder(),
      } as unknown as { brainId: string; queue: WriteQueue; phases: [4]; embedder: EmbeddingProvider });
      const md = await readFile(join(repoRoot, "brains/default/contradictions.md"), "utf8");
      // 灰区经 LLM 后应含 supersede
      expect(md.toLowerCase()).toMatch(/supersede/);
    },
    T,
  );
});
