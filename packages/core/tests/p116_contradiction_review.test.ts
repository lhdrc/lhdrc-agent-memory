/**
 * P11.6 冲突人工审阅 + fact 级软删
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  loadPack,
  WriteQueue,
  pgliteIndexHooks,
  captureNode,
  listContradictions,
  resolveContradiction,
  parseFrontmatter,
  sha256Hex,
  openPglite,
  hybridQuery,
  indexBodyText,
  type Fact,
} from "../src/index.ts";

const T = { timeout: 120_000 };
const NY = "Alice lives in New York QZUNIQUE_NYC_TOKEN";
const SF = "Alice lives in San Francisco QZUNIQUE_SFO_TOKEN";

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p116-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  const pack = await loadPack("problem-tree");
  const cfg = await loadRepoConfig(repoRoot);
  const queue = new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  return { repoRoot, pack, queue };
}

function fact(text: string): Fact {
  return {
    text,
    event_type: "observation",
    attributed_to: "cli:test",
    at: new Date().toISOString(),
  };
}

async function writeContra(repoRoot: string, a: string, b: string) {
  const abs = join(repoRoot, "brains/default/contradictions.md");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(
    abs,
    `# Contradictions\n\n## cross-file\n\n- duplicate cosine=0.9600 \`${a}\` facts[0] ↔ \`${b}\` facts[0]\n  - a: "${NY}"\n  - b: "${SF}"\n`,
    "utf8",
  );
}

describe("P11.6 contradiction review", () => {
  test("indexBodyText 去掉 superseded", () => {
    const body = `## 正文\n${NY}\nweather ok`;
    const out = indexBodyText(body, {
      facts: [{ text: NY, status: "superseded" }, { text: "keep me" }],
    });
    expect(out).not.toContain("New York");
    expect(out).toContain("keep me");
    expect(out).toContain("weather ok");
  });

  test(
    "P116-01 list pending",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "NY home",
        body: "weather note only",
        facts: [fact(NY)],
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "SF home",
        body: "other weather note",
        facts: [fact(SF)],
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const items = await listContradictions(repoRoot, "default");
      expect(items.length).toBe(1);
      expect(items[0]!.status).toBe("pending");
      expect(items[0]!.pathA).toBe(pathA);
      expect(items[0]!.pathB).toBe(pathB);
    },
    T,
  );

  test(
    "P116-02 keep a → B fact superseded，页仍 active，正文不变",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "NY home",
        body: "weather note only",
        facts: [fact(NY)],
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "SF home",
        body: "other weather note",
        facts: [fact(SF)],
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const pairId = (await listContradictions(repoRoot, "default"))[0]!.pair_id;
      const bodyBefore = parseFrontmatter(await readFile(join(repoRoot, pathB), "utf8")).body;
      const hashBefore = sha256Hex(bodyBefore);
      await resolveContradiction(repoRoot, "default", queue, { pairId, keep: "a", by: "cli:test" });
      const parsed = parseFrontmatter(await readFile(join(repoRoot, pathB), "utf8"));
      expect((parsed.data.facts as Array<{ status?: string }>)[0]?.status).toBe("superseded");
      expect(parsed.data.status).toBe("active");
      expect(sha256Hex(parsed.body)).toBe(hashBefore);
    },
    T,
  );

  test(
    "P116-03 keep both 不改 fact status",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "NY home",
        body: "weather note only",
        facts: [fact(NY)],
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "SF home",
        body: "other weather note",
        facts: [fact(SF)],
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const pairId = (await listContradictions(repoRoot, "default"))[0]!.pair_id;
      await resolveContradiction(repoRoot, "default", queue, { pairId, keep: "both", by: "cli:test" });
      const factsA = parseFrontmatter(await readFile(join(repoRoot, pathA), "utf8")).data.facts as Array<{
        status?: string;
      }>;
      const factsB = parseFrontmatter(await readFile(join(repoRoot, pathB), "utf8")).data.facts as Array<{
        status?: string;
      }>;
      expect(factsA[0]?.status).toBeUndefined();
      expect(factsB[0]?.status).toBeUndefined();
    },
    T,
  );

  test(
    "P116-04 keep a 后 query 旧 fact 不命中 B",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "NY home",
        body: "weather note only",
        facts: [fact(NY)],
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "SF home",
        body: "other weather note",
        facts: [fact(SF)],
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const pairId = (await listContradictions(repoRoot, "default"))[0]!.pair_id;
      await resolveContradiction(repoRoot, "default", queue, { pairId, keep: "a", by: "cli:test" });
      const conn = await openPglite(repoRoot);
      try {
        const indexed = await conn.db.query<{ body_text: string }>(
          `SELECT body_text FROM pages WHERE path = $1`,
          [pathB],
        );
        expect(indexed.rows[0]?.body_text ?? "").not.toContain("QZUNIQUE_SFO_TOKEN");
        const hits = await hybridQuery(conn.db, {
          brainId: "default",
          query: "QZUNIQUE_SFO_TOKEN",
          skipCache: true,
          limit: 10,
          repoRoot,
        });
        const hitB = hits.find((h) => h.path === pathB);
        expect(hitB?.snippet ?? "").not.toContain("QZUNIQUE_SFO_TOKEN");
        expect(hits.some((h) => h.path === pathB && (h.snippet ?? "").includes("QZUNIQUE_SFO_TOKEN"))).toBe(false);
      } finally {
        await conn.close();
      }
    },
    T,
  );

  test(
    "P116-05 dream 覆盖 contradictions.md 不丢 sidecar",
    async () => {
      const { repoRoot, pack, queue } = await boot();
      const pathA = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "NY home",
        body: "weather note only",
        facts: [fact(NY)],
        createdBy: "cli:test",
      });
      const pathB = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "SF home",
        body: "other weather note",
        facts: [fact(SF)],
        createdBy: "cli:test",
      });
      await writeContra(repoRoot, pathA, pathB);
      const pairId = (await listContradictions(repoRoot, "default"))[0]!.pair_id;
      await resolveContradiction(repoRoot, "default", queue, { pairId, keep: "a", by: "cli:test" });
      await writeContra(repoRoot, pathA, pathB);
      const items = await listContradictions(repoRoot, "default");
      expect(items[0]!.status).toBe("a");
    },
    T,
  );

  test("P116-06 无 LLM 符号", async () => {
    const files = [
      new URL("../src/contradiction/review.ts", import.meta.url),
      new URL("../src/contradiction/parse.ts", import.meta.url),
      new URL("../../cli/src/commands/contradiction.ts", import.meta.url),
    ];
    for (const url of files) {
      const src = await readFile(url, "utf8");
      expect(src).not.toMatch(/\.complete\s*\(/);
      expect(src).not.toMatch(/createLLMProvider/);
    }
  });
});
