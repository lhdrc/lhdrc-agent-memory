/**
 * P6.1 LLM complete API
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMemoryRepo,
  createLLMProvider,
  NoopLLMProvider,
  ErrorCodes,
  readCostLog,
  loadRepoConfig,
  type CompleteResult,
  type LLMProvider,
} from "../src/index.ts";

const T = { timeout: 60_000 };

function restoreEnv(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe("P6.1 LLM complete", () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevMock = process.env.DF_MEMORY_MOCK_COMPLETE;
  const prevFail = process.env.DF_MEMORY_MOCK_COMPLETE_FAIL;

  afterEach(() => {
    restoreEnv("OPENAI_API_KEY", prevKey);
    restoreEnv("DF_MEMORY_MOCK_COMPLETE", prevMock);
    restoreEnv("DF_MEMORY_MOCK_COMPLETE_FAIL", prevFail);
  });

  test("P61-01: provider=off → complete 抛 E_DISABLED", async () => {
    const p = createLLMProvider({ provider: "off" });
    expect(p.id).toBe("off");
    expect(p).toBeInstanceOf(NoopLLMProvider);
    try {
      await p.complete({ prompt: "ping", purpose: "compile" });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.code).toBe(ErrorCodes.DISABLED);
      expect(String(e.message)).toContain("llm.provider=off");
    }
  });

  test("P61-02: provider=openai → id===openai（即使无 key）", () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    delete process.env.DF_MEMORY_MOCK_COMPLETE_FAIL;
    delete process.env.OPENAI_API_KEY;
    const p = createLLMProvider({ provider: "openai" });
    expect(p.id).toBe("openai");
    expect(p).not.toBeInstanceOf(NoopLLMProvider);
  });

  test("P61-03: openai + 无环境变量 → complete 抛 E_DISABLED", async () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    delete process.env.OPENAI_API_KEY;
    const p = createLLMProvider({ provider: "openai" });
    await expect(p.complete({ prompt: "ping", purpose: "compile" })).rejects.toMatchObject({
      code: ErrorCodes.DISABLED,
    });
  });

  test("P61-04: 注入 mock → complete 返回 text", async () => {
    const mock: LLMProvider = {
      id: "mock",
      async complete(): Promise<CompleteResult> {
        return { text: "pong" };
      },
      async judgeDistill() {
        return { candidate: "skip", confidence: 0, rationale: "m" };
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
    const r = await mock.complete({ prompt: "ping", purpose: "compile" });
    expect(r.text).toBe("pong");
  });

  test("P61-05: kill_switch.compile=true + openai → purpose=compile 抛 E_DISABLED", async () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    const p = createLLMProvider({
      provider: "openai",
      kill_switch: { distill: false, abstract: false, extract: false, compile: true },
    });
    await expect(p.complete({ prompt: "ping", purpose: "compile" })).rejects.toMatchObject({
      code: ErrorCodes.DISABLED,
    });
  });

  test("P61-06: mock fetch 非 2xx → E_LLM", async () => {
    delete process.env.DF_MEMORY_MOCK_COMPLETE;
    process.env.OPENAI_API_KEY = "sk-test";
    const p = createLLMProvider(
      { provider: "openai" },
      {
        fetch: async () => new Response("nope", { status: 500, statusText: "ERR" }),
      },
    );
    await expect(p.complete({ prompt: "ping", purpose: "compile" })).rejects.toMatchObject({
      code: ErrorCodes.LLM,
    });
  });

  test("P61-07: Noop judgeDistill / generateAbstract 不回退", async () => {
    const p = new NoopLLMProvider();
    const d = await p.judgeDistill(["a"], "b");
    expect(d.candidate).toBe("skip");
    const abs = await p.generateAbstract("hello world ".repeat(20));
    expect(abs.length).toBeLessThanOrEqual(100);
  });

  test(
    "P61-08: mock 带 usage 的 complete → costs.jsonl 有 kind=compile",
    async () => {
      delete process.env.DF_MEMORY_MOCK_COMPLETE;
      process.env.OPENAI_API_KEY = "sk-test";
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p61-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const cfg = await loadRepoConfig(repoRoot);
      const p = createLLMProvider(
        { provider: "openai" },
        {
          repoRoot,
          cost: cfg.cost,
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "pong" } }],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
                model: "gpt-4o-mini",
              }),
              { status: 200 },
            ),
        },
      );
      await p.complete({ prompt: "ping", purpose: "compile" });
      const logs = await readCostLog(repoRoot, cfg.cost);
      expect(logs.some((e) => e.kind === "compile")).toBe(true);
    },
    T,
  );

  test(
    "init memory.yml 含 llm.model 与 kill_switch.compile",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dfmem-p61-yml-"));
      const repoRoot = await initMemoryRepo(dir, { brain: "default", source: "default", force: false });
      const yml = await readFile(join(repoRoot, "memory.yml"), "utf8");
      expect(yml).toContain("model: gpt-4o-mini");
      expect(yml).toContain("compile: false");
      expect(yml).toContain("dedupe_cosine: 0.95");
    },
    T,
  );
});
