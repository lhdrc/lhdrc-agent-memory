/**
 * P11.3 写入：duplicate ≠ update
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  checkDedupe,
  compileSession,
  loadSessionExtractPrompt,
  parseFrontmatter,
  ALREADY_IN_KB_HEADING,
  type CompleteRequest,
  type CompleteResult,
  type EmbeddingProvider,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 180_000 };

const NY = "Alice lives in New York";
const SF = "Alice lives in San Francisco";

/** 向量全相同 → cosine=1，用来锁冲突检测而不是假造 checkDedupe 返回值。 */
const highCosineEmbedder: EmbeddingProvider = {
  id: "mock-high-cosine",
  dims: 8,
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
  },
};

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

async function makeQueue(repoRoot: string): Promise<WriteQueue> {
  const cfg = await loadRepoConfig(repoRoot);
  return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
}

function mockLlm(text: string | ((req: CompleteRequest) => string), onCall?: (req: CompleteRequest) => void): LLMProvider {
  return {
    id: "mock",
    async complete(req): Promise<CompleteResult> {
      onCall?.(req);
      const t = typeof text === "function" ? text(req) : text;
      return { text: t };
    },
    async judgeDistill() {
      return { candidate: "skip" as const, confidence: 0, rationale: "m" };
    },
    async generateAbstract(c: string) {
      return c.slice(0, 10);
    },
    async generateOverview(c: string[]) {
      return c.join("");
    },
    async refineExperience(ctx) {
      return { title: ctx.title, trigger: "t", procedure: "p", boundary: "b", body: ctx.candidate };
    },
  };
}

async function setupRepo(): Promise<{ repoRoot: string; pack: Awaited<ReturnType<typeof loadPack>> }> {
  const dir = await mkdtemp(join(tmpdir(), "dfmem-p113-"));
  const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
  await patchMemoryYml(repoRoot, {
    embedding: { provider: "local" },
    write: { dedupe_cosine: 0.95, dedupe_window: 200 },
  });
  return { repoRoot, pack: await loadPack("problem-tree") };
}

describe("P11.3 duplicate ≠ update", () => {
  test(
    "P113-01 mock 高余弦 NY vs SF → duplicate=false，两篇都在仓",
    async () => {
      const { repoRoot, pack } = await setupRepo();
      const queue = await makeQueue(repoRoot);
      const pathNy = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: NY,
        body: NY,
        createdBy: "cli:test",
      });
      const cfg = await loadRepoConfig(repoRoot);
      const r = await checkDedupe(repoRoot, "default", "", SF, cfg, highCosineEmbedder);
      expect(r.duplicate).toBe(false);
      expect(r.skipped_reason).toBeUndefined();

      const pathSf = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: SF,
        body: SF,
        createdBy: "cli:test",
      });
      expect(existsSync(join(repoRoot, pathNy))).toBe(true);
      expect(existsSync(join(repoRoot, pathSf))).toBe(true);
      expect(pathNy).not.toBe(pathSf);
    },
    T,
  );

  test(
    "P113-02 mock 高余弦且文本几乎全等（仅空白）→ duplicate=true",
    async () => {
      const { repoRoot, pack } = await setupRepo();
      const queue = await makeQueue(repoRoot);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: NY,
        body: NY,
        createdBy: "cli:test",
      });
      const cfg = await loadRepoConfig(repoRoot);
      const r = await checkDedupe(repoRoot, "default", "", "Alice  lives  in  New   York", cfg, highCosineEmbedder);
      expect(r.duplicate).toBe(true);
      expect(r.matchedPath).toBeTruthy();
    },
    T,
  );

  test("P113-03 提取合同含同一主语不同取值必须新 item", async () => {
    const prompt = await loadSessionExtractPrompt();
    expect(prompt).toContain("same subject with a different value");
    expect(prompt).toContain("同一主语、不同取值");
    expect(prompt).toContain("必须再输出一条新 item");
    expect(prompt).toContain("Do not skip because a near-paraphrase");
  });

  test(
    "P113-04 prefetch 旧 NY + 用户搬去 SF → 新 md 含 San Francisco，旧正文不变",
    async () => {
      const { repoRoot, pack } = await setupRepo();
      const queue = await makeQueue(repoRoot);
      const oldPath = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "Alice lives in New York",
        body: "STABLE_NY_BODY_TOKEN Alice lives in New York.",
        createdBy: "cli:test",
      });
      const oldRaw = await readFile(join(repoRoot, oldPath), "utf8");

      let seenPrompt = "";
      const r = await compileSession({
        repoRoot,
        brainId: "default",
        sourceId: "default",
        createdBy: "cli:test",
        pack,
        queue,
        turns: [{ role: "user", text: "Alice moved to San Francisco. She no longer lives in New York." }],
        llm: mockLlm(
          JSON.stringify({
            items: [
              {
                type: "note",
                title: "Alice moved to San Francisco",
                body: "Alice lives in San Francisco now.",
                facts: [{ text: SF, supersedes: NY }],
              },
            ],
          }),
          (req) => {
            seenPrompt = `${req.system ?? ""}\n${req.prompt}`;
          },
        ),
      });

      expect(seenPrompt).toContain(ALREADY_IN_KB_HEADING);
      expect(seenPrompt).toContain("Alice lives in New York");
      expect(r.kept.length).toBeGreaterThanOrEqual(1);
      const newPath = r.kept[0]!.path;
      expect(newPath).toBeTruthy();
      expect(newPath).not.toBe(oldPath);
      const newRaw = await readFile(join(repoRoot, newPath!), "utf8");
      expect(newRaw).toContain("San Francisco");
      const oldAfter = await readFile(join(repoRoot, oldPath), "utf8");
      expect(oldAfter).toBe(oldRaw);
      expect(oldAfter).toContain("STABLE_NY_BODY_TOKEN");
    },
    T,
  );

  test(
    "P113-05 facts[].supersedes 超长被丢弃，节点仍写入",
    async () => {
      const { repoRoot, pack } = await setupRepo();
      const queue = await makeQueue(repoRoot);
      const tooLong = "x".repeat(501);
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "supersedes 超长",
        body: "仍应落盘。",
        createdBy: "cli:test",
        facts: [
          {
            text: SF,
            event_type: "note",
            attributed_to: "cli:test",
            at: "2026-08-01",
            supersedes: tooLong,
          },
        ],
      });
      expect(existsSync(join(repoRoot, path))).toBe(true);
      const { data } = parseFrontmatter(await readFile(join(repoRoot, path), "utf8"));
      const facts = data.facts as Array<Record<string, unknown>>;
      expect(Array.isArray(facts) && facts.length).toBeGreaterThan(0);
      expect(facts[0]!.supersedes).toBeUndefined();
      expect(String(facts[0]!.text)).toContain(SF);
    },
    T,
  );

  test(
    "P113-06 dedupe_cosine: 0 不走冲突检测，不误标 duplicate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p113-06-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      await patchMemoryYml(repoRoot, {
        embedding: { provider: "local" },
        write: { dedupe_cosine: 0, dedupe_window: 200 },
      });
      const pack = await loadPack("problem-tree");
      const queue = await makeQueue(repoRoot);
      await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: NY,
        body: NY,
        createdBy: "cli:test",
      });
      const cfg = await loadRepoConfig(repoRoot);
      expect(cfg.write.dedupe_cosine).toBe(0);
      const r = await checkDedupe(repoRoot, "default", "", SF, cfg, highCosineEmbedder);
      expect(r.duplicate).toBe(false);
    },
    T,
  );
});
