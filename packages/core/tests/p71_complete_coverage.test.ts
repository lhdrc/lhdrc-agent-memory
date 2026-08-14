/**
 * P7.1 extract / layers / capture --extract 验收
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  enrichAfterWrite,
  refreshLayers,
  parseFrontmatter,
  heuristicAbstract,
} from "../src/index.ts";

const T = { timeout: 180_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");
const MOCK_ABSTRACT = "MOCK_ABSTRACT_P71_UNIQUE";
const MOCK_FACT = "MOCK_FACT_RETRY_FIXED_3";

function restoreEnv(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

const MOCK_KEYS = [
  "DF_MEMORY_MOCK_COMPLETE",
  "DF_MEMORY_MOCK_COMPLETE_DISTILL",
  "DF_MEMORY_MOCK_COMPLETE_EXTRACT",
  "DF_MEMORY_MOCK_COMPLETE_ABSTRACT",
  "DF_MEMORY_MOCK_COMPLETE_COMPILE",
  "DF_MEMORY_MOCK_COMPLETE_FAIL",
] as const;

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

async function runCli(
  repoRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ exit: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DF_MEMORY_ROOT: repoRoot,
    ...extraEnv,
  };
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

describe("P7.1 extract / layers coverage", () => {
  let repoRoot: string;
  let pack: Awaited<ReturnType<typeof loadPack>>;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of MOCK_KEYS) prev[k] = process.env[k];
    prev.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p71c-"));
    repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    pack = await loadPack("problem-tree");
  });

  afterEach(() => {
    restoreEnv("OPENAI_API_KEY", prev.OPENAI_API_KEY);
    for (const k of MOCK_KEYS) restoreEnv(k, prev[k]);
  });

  async function makeQueue() {
    const cfg = await loadRepoConfig(repoRoot);
    return new WriteQueue(repoRoot, cfg, pgliteIndexHooks);
  }

  test(
    "P71-03 enrich 在 openai extractFacts 存在时不走启发式",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      process.env.DF_MEMORY_MOCK_COMPLETE_EXTRACT = JSON.stringify({
        facts: [{ text: MOCK_FACT, event_type: "note", attributed_to: "t", at: "2026-08-14" }],
      });
      const queue = await makeQueue();
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "启发式对照",
        body: "- 启发式列表项不该出现\n\n纯叙述。",
        createdBy: "cli:test",
      });
      const enrich = await enrichAfterWrite({
        repoRoot,
        brainId: "default",
        path,
        queue,
        extract: true,
      });
      expect(enrich?.extracted_facts).toBe(1);
      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data } = parseFrontmatter(raw);
      const facts = (data.facts as Array<{ text: string }>) ?? [];
      expect(facts.some((f) => f.text === MOCK_FACT)).toBe(true);
      expect(facts.some((f) => f.text.includes("启发式列表项"))).toBe(false);
    },
    T,
  );

  test(
    "P71-08 layers openai mock abstract 等于 mock 且 llm_abstract",
    async () => {
      const queue = await makeQueue();
      const body = `支付网关超时后采用固定三次重试策略。\n\n${"填充段落。".repeat(20)}`;
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "分层 LLM",
        body,
        createdBy: "cli:test",
      });
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const refresh = await runCli(repoRoot, ["layers", "refresh", "--path", path, "--json"], {
        DF_MEMORY_MOCK_COMPLETE_ABSTRACT: MOCK_ABSTRACT,
      });
      expect(refresh.exit).toBe(0);
      const json = JSON.parse(refresh.out) as {
        updated: Array<{ path: string; llm_abstract?: boolean }>;
      };
      const row = json.updated.find((u) => u.path === path);
      expect(row?.llm_abstract).toBe(true);
      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data } = parseFrontmatter(raw);
      expect(String(data.abstract)).toBe(MOCK_ABSTRACT);
      expect(String(data.abstract)).not.toBe(heuristicAbstract(body));
    },
    T,
  );

  test(
    "P71-09 layers provider=off 仍启发式",
    async () => {
      const queue = await makeQueue();
      const body = `支付网关超时后采用固定三次重试策略。\n\n${"填充段落。".repeat(20)}`;
      const path = await captureNode(repoRoot, pack, queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: "分层 off",
        body,
        createdBy: "cli:test",
      });
      const result = await refreshLayers({
        repoRoot,
        brainId: "default",
        queue,
        path,
      });
      expect(result.updated[0]?.llm_abstract).toBeUndefined();
      const raw = await readFile(join(repoRoot, path), "utf8");
      const { data, body: stored } = parseFrontmatter(raw);
      expect(String(data.abstract)).toBe(heuristicAbstract(stored));
      expect(String(data.abstract).length).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "P71-11 capture --extract openai mock facts 写入 frontmatter",
    async () => {
      await patchMemoryYml(repoRoot, { llm: { provider: "openai" } });
      const mockJson = JSON.stringify({
        facts: [{ text: MOCK_FACT, event_type: "decision", attributed_to: "cli:test", at: "2026-08-14" }],
      });
      const cap = await runCli(
        repoRoot,
        [
          "capture",
          "--title",
          "重试策略",
          "--type",
          "decision",
          "--body",
          "我们决定重试改为固定3次，不再用指数退避。",
          "--extract",
          "--json",
        ],
        { DF_MEMORY_MOCK_COMPLETE_EXTRACT: mockJson },
      );
      expect(cap.exit).toBe(0);
      const parsed = JSON.parse(cap.out) as { path: string; enrich?: { extracted_facts?: number } };
      expect(parsed.enrich?.extracted_facts).toBe(1);
      const raw = await readFile(join(repoRoot, parsed.path), "utf8");
      const { data } = parseFrontmatter(raw);
      const facts = (data.facts as Array<{ text: string }>) ?? [];
      expect(facts.some((f) => f.text === MOCK_FACT)).toBe(true);
    },
    T,
  );
});
