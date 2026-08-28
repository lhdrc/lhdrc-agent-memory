/**
 * P12.2 宿主 agent 错误信封
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  loadRepoConfig,
  createEmbeddingProvider,
  openPglite,
  hybridQueryDetailed,
  ErrorCodes,
  MemoryError,
  type EmbeddingProvider,
} from "../src/index.ts";

const T = { timeout: 60_000 };
const bunBin = process.execPath;
const cliMain = join(import.meta.dir, "../../cli/src/main.ts");

function hermeticEnv(repoRoot: string, extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, DF_MEMORY_ROOT: repoRoot, ...extra };
  delete env.OPENAI_API_KEY;
  delete env.DF_MEMORY_MOCK_COMPLETE;
  delete env.DF_MEMORY_MOCK_COMPLETE_FAIL;
  delete env.DF_MEMORY_MOCK_COMPLETE_COMPILE;
  return env;
}

async function runCli(
  repoRoot: string,
  args: string[],
  extra?: Record<string, string | undefined>,
): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [bunBin, cliMain, ...args],
    cwd: repoRoot,
    env: hermeticEnv(repoRoot, extra),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err: err.trim() };
}

describe("P12.2 宿主 agent 错误信封", () => {
  test("P122-01 provider=openai 无 Key：degradation 含 semantic_hash_fallback", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p122-01-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const cfg = await loadRepoConfig(repoRoot);
      const embedder = createEmbeddingProvider(cfg.embedding);
      const conn = await openPglite(repoRoot);
      try {
        const r = await hybridQueryDetailed(conn.db, {
          brainId: "default",
          query: "重试",
          embedder,
          repoRoot,
          skipCache: true,
        });
        expect(r.degradation?.some((d) => d.reason === "semantic_hash_fallback")).toBe(true);
        expect(Array.isArray(r.hits)).toBe(true);
      } finally {
        await conn.close();
      }
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  }, T);

  test("P122-02 embedder.embed 抛错：degradation 含 semantic 臂", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p122-02-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const embedder: EmbeddingProvider = {
      id: "openai",
      dims: 8,
      embed: async () => {
        throw new MemoryError(ErrorCodes.LLM, "503 unavailable");
      },
    };
    const conn = await openPglite(repoRoot);
    try {
      const r = await hybridQueryDetailed(conn.db, {
        brainId: "default",
        query: "重试",
        embedder,
        repoRoot,
        skipCache: true,
      });
      const d = r.degradation?.find((x) => x.arm === "semantic");
      expect(d).toBeTruthy();
      expect(d?.reason).toBe("semantic_embed_failed");
      expect(r.hits.every((h) => !h.evidence.includes("semantic"))).toBe(true);
    } finally {
      await conn.close();
    }
  }, T);

  test("P122-03 query --json 无 Key：ok true + hash fallback + results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p122-03-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const cap = await runCli(repoRoot, [
      "capture",
      "--wait",
      "--title",
      "信封笔记",
      "--type",
      "note",
      "--body",
      "重试策略",
    ]);
    expect(cap.exit).toBe(0);
    const q = await runCli(repoRoot, ["query", "重试", "--json"]);
    expect(q.exit).toBe(0);
    const parsed = JSON.parse(q.out) as {
      ok: boolean;
      results: unknown[];
      degradation?: Array<{ reason: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.degradation?.some((d) => d.reason === "semantic_hash_fallback")).toBe(true);
  }, T);

  test("P122-04 remember --json 无 llm：ok false E_DISABLED 且不入队", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p122-04-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, ["remember", "--json", "--body", "我们决定改重试"]);
    expect(r.exit).not.toBe(0);
    const parsed = JSON.parse(r.err || r.out) as { ok: boolean; error?: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe(ErrorCodes.DISABLED);
    const jobsDir = join(repoRoot, ".dfmemory", "jobs", "default");
    if (existsSync(jobsDir)) {
      const files = (await readdir(jobsDir)).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(0);
    }
  }, T);

  test("P122-05 remember --no-extract --json --wait 无 llm：不因缺 LLM 失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dfmem-p122-05-"));
    const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
    const r = await runCli(repoRoot, [
      "remember",
      "--no-extract",
      "--json",
      "--wait",
      "--body",
      "一条无需抽取的笔记",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.out) as { ok?: boolean; kept?: unknown[]; result?: { kept?: unknown[] } };
    const kept = parsed.kept ?? parsed.result?.kept;
    expect(parsed.ok === true || (Array.isArray(kept) && kept.length > 0)).toBe(true);
  }, T);
});
