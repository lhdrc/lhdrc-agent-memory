import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  captureNode,
  compileSession,
  createLLMProvider,
  hybridQuery,
  isEnvMockCompleteEnabled,
  LocalHashEmbedding,
  loadRepoConfig,
  MemoryError,
  ErrorCodes,
  openPglite,
  resolveEmbedder,
  type EmbeddingProvider,
  type LLMProvider,
  type QueryHit,
} from "../packages/core/src/index.ts";
import { LOCOMO_FULL_URL } from "./fetch.ts";
import { cacheDir, fixtureDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import {
  isScoreCategory,
  loadLocomoPublishFile,
  type LocomoPublishSample,
} from "./adapters/locomo.ts";
import {
  formatAnswerPrompt,
  formatJudgePrompt,
  locomoPromptHash,
  parseJudgeVerdict,
} from "./adapters/locomo-prompts.ts";

const TOP_K = 5;
/** P10.1 用户锁定：聊天三套 DeepSeek-V4-Flash；embedding Qwen3-8B。默认硅基流动兼容 API。 */
const CHAT_MODEL = process.env.DF_EVAL_CHAT_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Flash";
const EMBED_MODEL = process.env.DF_EVAL_EMBED_MODEL?.trim() || "Qwen/Qwen3-Embedding-8B";
const EMBED_DIMS = Number(process.env.DF_EVAL_EMBED_DIMS ?? 4096) || 4096;
const API_BASE = (process.env.DF_EVAL_API_BASE?.trim() || "https://api.siliconflow.cn").replace(/\/+$/, "");
const MISSING =
  "LoCoMo 数据未准备。请使用 --fixture 跑仓内样例，或执行 memory eval fetch --adapter locomo --allow-net";

function evalKeyEnv(): string {
  if (process.env.DF_EVAL_API_KEY?.trim()) return "DF_EVAL_API_KEY";
  if (process.env.SILICONFLOW_API_KEY?.trim()) return "SILICONFLOW_API_KEY";
  return "OPENAI_API_KEY";
}

function hasEvalKey(envName: string): boolean {
  return Boolean(process.env[envName]?.trim());
}

type SampleStatus = "compiled" | "qa_done" | "failed";

interface RunSampleState {
  status: SampleStatus;
  n?: number;
  hits?: number;
  compile_failed?: boolean;
  compile_sessions?: number;
  l0_written?: number;
}

interface RunState {
  run_id: string;
  samples: Record<string, RunSampleState>;
}

export interface LocomoPublishOpts {
  sample?: string;
  resume?: string;
  runId?: string;
  allowHashEmbed?: boolean;
  ingest?: "compile" | "capture";
  concurrency?: number;
  json?: boolean;
}

function goldText(gold: string | string[]): string {
  return Array.isArray(gold) ? gold.join(" | ") : String(gold);
}

function memoriesBlob(hits: QueryHit[]): string {
  if (hits.length === 0) return "(none)";
  return hits
    .map((h, i) => {
      const abs = h.abstract?.trim();
      const body = [h.title, abs, h.snippet].filter(Boolean).join("\n");
      return `[${i + 1}] ${h.path}\n${body}`;
    })
    .join("\n\n");
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

function addUsage(
  bag: { in: number; out: number },
  usage?: { prompt_tokens: number; completion_tokens: number },
): void {
  bag.in += usage?.prompt_tokens ?? 0;
  bag.out += usage?.completion_tokens ?? 0;
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function patchPublishYml(repoRoot: string, keyEnv: string): Promise<void> {
  const path = join(repoRoot, "memory.yml");
  let yml = await readFile(path, "utf8");
  yml = yml.replace(/^llm:\n  provider: off/m, "llm:\n  provider: openai");
  yml = yml.replace(/^  model: gpt-4o-mini$/m, `  model: ${CHAT_MODEL}`);
  yml = yml.replace(/^  model: text-embedding-3-small$/m, `  model: ${EMBED_MODEL}`);
  yml = yml.replace(/^  dims: 1536$/m, `  dims: ${EMBED_DIMS}`);
  yml = yml.replace(/^  base_url: https:\/\/api\.openai\.com$/m, `  base_url: ${API_BASE}`);
  yml = yml.replace(/^  openai_api_key_env: OPENAI_API_KEY$/gm, `  openai_api_key_env: ${keyEnv}`);
  yml = yml.replace(/^  onnx_model_path: ""$/m, `  onnx_model_path: ""\n  base_url: ${API_BASE}`);
  yml = yml.replace(/^  distill: true$/m, "  distill: false");
  yml = yml.replace(/^    distill: false$/m, "    distill: true");
  yml = yml.replace(/^  lazy_min_sources: 5$/m, "  lazy_min_sources: 9999");
  yml = yml.replace(/^  auto_crystallize: true$/m, "  auto_crystallize: false");
  await writeFile(path, yml, "utf8");
}

async function countL0(repoRoot: string, brainId: string): Promise<number> {
  const root = join(repoRoot, "brains", brainId, "sources");
  let n = 0;
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) n++;
    }
  }
  await walk(root);
  return n;
}

async function ingestCapture(
  ws: import("./lib/workspace.ts").EvalWorkspace,
  sample: LocomoPublishSample,
  createdBy: string,
): Promise<{ sessions: number; notes: number }> {
  let sessions = 0;
  let notes = 0;
  for (const sess of sample.sessions) {
    sessions++;
    let n = 0;
    for (const t of sess.turns) {
      n++;
      const title = `${sample.sample_id}-s${sess.index}-t${n}`;
      await captureNode(ws.repoRoot, ws.pack, ws.queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title,
        body: t.text,
        createdBy,
      });
      notes++;
    }
  }
  return { sessions, notes };
}

function wrapLlm(
  inner: LLMProvider,
  compileTok: { compile_in: number; compile_out: number },
): LLMProvider {
  return {
    id: inner.id,
    complete: async (req) => {
      const out = await inner.complete(req);
      if (req.purpose === "compile") {
        compileTok.compile_in += out.usage?.prompt_tokens ?? 0;
        compileTok.compile_out += out.usage?.completion_tokens ?? 0;
      }
      return out;
    },
    judgeDistill: (existing, candidate) => inner.judgeDistill(existing, candidate),
    generateAbstract: (content) => inner.generateAbstract(content),
    generateOverview: (children) => inner.generateOverview(children),
    refineExperience: (ctx) => inner.refineExperience(ctx),
    extractFacts: inner.extractFacts ? (body, meta) => inner.extractFacts!(body, meta) : undefined,
  };
}

function mockEmbedder(): EmbeddingProvider {
  const inner = new LocalHashEmbedding(384);
  return {
    id: "openai",
    dims: 384,
    embed: (texts) => inner.embed(texts),
  };
}

function runDir(runId: string): string {
  return join(cacheDir("locomo"), "runs", runId);
}

async function loadRunState(runId: string): Promise<RunState> {
  const p = join(runDir(runId), "state.json");
  if (!existsSync(p)) return { run_id: runId, samples: {} };
  return JSON.parse(await readFile(p, "utf8")) as RunState;
}

async function saveRunState(state: RunState): Promise<void> {
  const dir = runDir(state.run_id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

async function resolveData(opts: LocomoPublishOpts): Promise<{
  samples: LocomoPublishSample[];
  sourcePath: string;
  datasetUrl: string;
}> {
  const cached = join(cacheDir("locomo"), "data.json");
  const fixturePath = join(fixtureDir("locomo-sample"), "sample.json");
  if (existsSync(cached)) {
    let samples = await loadLocomoPublishFile(cached);
    if (opts.sample) samples = samples.filter((s) => s.sample_id === opts.sample);
    if (opts.sample && samples.length === 0) {
      throw new Error(`sample_id 不在已 fetch 的数据中: ${opts.sample}`);
    }
    return { samples, sourcePath: cached, datasetUrl: LOCOMO_FULL_URL };
  }
  if (opts.sample && existsSync(fixturePath)) {
    let samples = await loadLocomoPublishFile(fixturePath);
    samples = samples.filter((s) => s.sample_id === opts.sample);
    if (samples.length === 0) {
      throw new Error(`sample_id 不在仓内 fixture 中: ${opts.sample}。全量请 fetch --allow-net`);
    }
    return { samples, sourcePath: fixturePath, datasetUrl: `fixture:${fixturePath}` };
  }
  throw new Error(MISSING);
}

export async function runLocomoPublish(opts: LocomoPublishOpts): Promise<number> {
  let loaded: { samples: LocomoPublishSample[]; sourcePath: string; datasetUrl: string };
  try {
    loaded = await resolveData(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return 1;
  }

  const useMockEmbed = process.env.DF_EVAL_MOCK_EMBED === "1";
  const keyEnv = evalKeyEnv();
  const cfgProbe = {
    provider: "openai" as const,
    model: EMBED_MODEL,
    dims: EMBED_DIMS,
    openai_api_key_env: keyEnv,
    base_url: API_BASE,
  };
  const resolved = useMockEmbed
    ? { embedder: mockEmbedder(), fallback: false }
    : resolveEmbedder(cfgProbe);
  if (resolved.fallback && !opts.allowHashEmbed) {
    console.error(
      `embedding 无 Key（${keyEnv}），语义臂会降级哈希。发数请配置 ${keyEnv}（硅基流动）或 OPENAI_API_KEY；调试可加 --allow-hash-embed`,
    );
    return 1;
  }

  const llmEnabled = isEnvMockCompleteEnabled() || hasEvalKey(keyEnv);
  if (!llmEnabled) {
    console.error(
      `缺少 API Key（${keyEnv}，E_DISABLED）。compile/答题/judge 需要 Key。硅基流动可设 SILICONFLOW_API_KEY 或 DF_EVAL_API_KEY`,
    );
    return 1;
  }

  const runId =
    opts.resume?.trim() ||
    opts.runId?.trim() ||
    process.env.DF_EVAL_RUN_ID?.trim() ||
    new Date().toISOString().replace(/[:.]/g, "-");
  const ingestMode = opts.ingest ?? "compile";
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1) || 1);
  const state = opts.resume ? await loadRunState(runId) : { run_id: runId, samples: {} as Record<string, RunSampleState> };
  state.run_id = runId;
  await mkdir(runDir(runId), { recursive: true });

  const datasetSha = await sha256File(loaded.sourcePath);
  const promptHash = locomoPromptHash();
  const ts = new Date().toISOString();

  const tokens = {
    compile_in: 0,
    compile_out: 0,
    answer_in: 0,
    answer_out: 0,
    judge_in: 0,
    judge_out: 0,
    embed: 0,
    answer_in_per_query: [] as number[],
  };
  const lat = {
    compile: [] as number[],
    query: [] as number[],
    answer: [] as number[],
    judge: [] as number[],
  };

  const caseRows: Array<{
    id: string;
    sample_id: string;
    category: number;
    score: number;
    predicted: string;
    verdict: string;
  }> = [];
  const compileFailedIds: string[] = [];
  const compileErrors: Array<{ sample_id: string; code?: string; message: string }> = [];
  let compileSessions = 0;
  let skippedSamples = 0;
  let l0Written = 0;

  const scoredCats: Record<string, { n: number; hits: number }> = {
    "1": { n: 0, hits: 0 },
    "2": { n: 0, hits: 0 },
    "3": { n: 0, hits: 0 },
    "4": { n: 0, hits: 0 },
  };

  type CaseRow = (typeof caseRows)[number];
  /** 单题：query → answer → judge。并发安全：JS 单线程，累加器在 await 间隙不会被打断。 */
  async function scoreOne(
    qa: LocomoQa,
    llm: LLMProvider,
    embedder: EmbeddingProvider,
    repoRoot: string,
    conn: Awaited<ReturnType<typeof openPglite>>,
    sampleId: string,
    withQuery: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<{ row: CaseRow; sampleHits: number }> {
    const q0 = Date.now();
    const hits = await withQuery(() =>
      hybridQuery(conn.db, {
        brainId: "default",
        query: qa.question,
        skipCache: true,
        limit: TOP_K,
        mode: "balanced",
        embedder,
        repoRoot,
        excludeSchemaTypes: ["skill"],
        excludeSidecars: true,
      }),
    );
    lat.query.push(Date.now() - q0);

    const mem = memoriesBlob(hits);
    const ansP = formatAnswerPrompt(qa.question, mem);
    const a0 = Date.now();
    const ans = await llm.complete({ purpose: "other", system: ansP.system, prompt: ansP.prompt });
    lat.answer.push(Date.now() - a0);
    addUsage({ in: 0, out: 0 }, ans.usage);
    tokens.answer_in += ans.usage?.prompt_tokens ?? 0;
    tokens.answer_out += ans.usage?.completion_tokens ?? 0;
    tokens.answer_in_per_query.push(ans.usage?.prompt_tokens ?? 0);
    tokens.embed += Math.ceil(qa.question.length / 4);

    const predicted = String(ans.text ?? "").trim();
    const jP = formatJudgePrompt(qa.question, goldText(qa.answer), predicted);
    const j0 = Date.now();
    const judged = await llm.complete({ purpose: "other", system: jP.system, prompt: jP.prompt });
    lat.judge.push(Date.now() - j0);
    tokens.judge_in += judged.usage?.prompt_tokens ?? 0;
    tokens.judge_out += judged.usage?.completion_tokens ?? 0;

    const verdict = parseJudgeVerdict(judged.text);
    const score = verdict === "CORRECT" ? 1 : 0;
    const cat = scoredCats[String(qa.category)]!;
    cat.n++;
    cat.hits += score;
    const row: CaseRow = {
      id: `${sampleId}-q${qa.index}`,
      sample_id: sampleId,
      category: qa.category,
      score,
      predicted,
      verdict,
    };
    return { row, sampleHits: score };
  }

  const totalSamples = loaded.samples.length;
  for (let si = 0; si < totalSamples; si++) {
    const sample = loaded.samples[si]!;
    const prev = state.samples[sample.sample_id];
    if (prev?.status === "qa_done") {
      skippedSamples++;
      if (typeof prev.n === "number" && typeof prev.hits === "number") {
        // resume 已计入 qa.jsonl；此处不重复加 n，后面从 jsonl 重读
      }
      continue;
    }

    const sampleStart = Date.now();
    console.log(
      `[progress] sample ${sample.sample_id} 开始 (${si + 1}/${totalSamples}) sessions=${sample.sessions.length} qa=${sample.qa.length}`,
    );
    const ws = await createEvalWorkspace({ brain: "default", git: "off" });
    try {
      await patchPublishYml(ws.repoRoot, keyEnv);
      const cfg = await loadRepoConfig(ws.repoRoot);
      const llm: LLMProvider = wrapLlm(
        createLLMProvider(cfg.llm, {
          repoRoot: ws.repoRoot,
          cost: cfg.cost,
          timeoutMs: Number(process.env.DF_EVAL_COMPLETE_TIMEOUT_MS ?? 180_000) || 180_000,
        }),
        tokens,
      );
      const embedder = resolved.embedder;

      let sampleCompileFailed = false;
      let sampleCompileSessions = 0;
      if (ingestMode === "capture") {
        const t0 = Date.now();
        try {
          const r = await ingestCapture(ws, sample, `eval:locomo:${sample.sample_id}`);
          sampleCompileSessions = r.sessions;
          compileSessions += r.sessions;
          lat.compile.push(Date.now() - t0);
        } catch (e) {
          sampleCompileFailed = true;
          lat.compile.push(Date.now() - t0);
          const code = e instanceof MemoryError ? e.code : ErrorCodes.LLM;
          const message = e instanceof Error ? e.message : String(e);
          compileErrors.push({ sample_id: sample.sample_id, code, message });
          if (code !== ErrorCodes.DISABLED && code !== ErrorCodes.LLM) {
            throw e;
          }
        }
      } else {
      for (const sess of sample.sessions) {
        const t0 = Date.now();
        try {
          const result = await compileSession({
            repoRoot: ws.repoRoot,
            brainId: "default",
            sourceId: "default",
            createdBy: `eval:locomo:${sample.sample_id}`,
            pack: ws.pack,
            queue: ws.queue,
            turns: sess.turns,
            llm,
          });
          sampleCompileSessions++;
          compileSessions++;
          lat.compile.push(Date.now() - t0);
          if (result.errors.some((e) => e.code === ErrorCodes.DISABLED)) {
            sampleCompileFailed = true;
            break;
          }
        } catch (e) {
          sampleCompileFailed = true;
          lat.compile.push(Date.now() - t0);
          const code = e instanceof MemoryError ? e.code : ErrorCodes.LLM;
          const message = e instanceof Error ? e.message : String(e);
          compileErrors.push({ sample_id: sample.sample_id, code, message });
          if (code !== ErrorCodes.DISABLED && code !== ErrorCodes.LLM) {
            throw e;
          }
          break;
        }
      }
      }

      const written = await countL0(ws.repoRoot, "default");
      l0Written += written;

      if (sampleCompileFailed) {
        compileFailedIds.push(sample.sample_id);
        const err = compileErrors.find((e) => e.sample_id === sample.sample_id);
        state.samples[sample.sample_id] = {
          status: "failed",
          compile_failed: true,
          compile_sessions: sampleCompileSessions,
          l0_written: written,
          n: 0,
          hits: 0,
          ...(err ? { error: `${err.code ?? "?"}: ${err.message.slice(0, 300)}` } : {}),
        };
        await saveRunState(state);
        console.log(
          `[progress] sample ${sample.sample_id} 编译失败 sessions=${sampleCompileSessions} l0=${written} (耗时 ${Math.round((Date.now() - sampleStart) / 1000)}s)`,
        );
        continue;
      }

      state.samples[sample.sample_id] = {
        status: "compiled",
        compile_sessions: sampleCompileSessions,
        l0_written: written,
      };
      await saveRunState(state);
      console.log(
        `[progress] sample ${sample.sample_id} 编译完成 sessions=${sampleCompileSessions} l0=${written} (耗时 ${Math.round((Date.now() - sampleStart) / 1000)}s)，开始答题`,
      );

      const toScore = sample.qa.filter((q) => isScoreCategory(q.category));
      let sampleN = 0;
      let sampleHits = 0;
      const qaPath = join(runDir(runId), "qa.jsonl");
      // 单连接 + 查询互斥：PGlite 不支持同库多连接并发，故查询串行；
      // answer/judge 的 LLM 等待在各并发槽内重叠，仍是主要提速来源。
      const conn = await openPglite(ws.repoRoot);
      try {
        let queryChain: Promise<unknown> = Promise.resolve();
        const withQuery = <T>(fn: () => Promise<T>): Promise<T> => {
          const run = queryChain.then(fn);
          queryChain = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        };
        for (let i = 0; i < toScore.length; i += concurrency) {
          const chunk = toScore.slice(i, i + concurrency);
          const results = await Promise.all(
            chunk.map((qa) =>
              scoreOne(qa, llm, embedder, ws.repoRoot, conn, sample.sample_id, withQuery),
            ),
          );
          for (const r of results) {
            caseRows.push(r.row);
            sampleN += 1;
            sampleHits += r.sampleHits;
          }
          await appendFile(qaPath, results.map((r) => JSON.stringify(r.row)).join("\n") + "\n", "utf8");
          console.log(
            `[progress] sample ${sample.sample_id} 答题 ${Math.min(i + chunk.length, toScore.length)}/${toScore.length} 命中=${sampleHits} 已耗时 ${Math.round((Date.now() - sampleStart) / 1000)}s`,
          );
        }
      } finally {
        await conn.close();
      }

      state.samples[sample.sample_id] = {
        status: "qa_done",
        n: sampleN,
        hits: sampleHits,
        compile_sessions: sampleCompileSessions,
        l0_written: written,
      };
      await saveRunState(state);
      console.log(
        `[progress] sample ${sample.sample_id} 完成 n=${sampleN} hits=${sampleHits} 耗时 ${Math.round((Date.now() - sampleStart) / 1000)}s（累计 ${compileSessions} 会话 / L0 ${l0Written}）`,
      );
    } finally {
      await ws.dispose();
    }
  }

  // resume：把已 qa_done 且本次 skipped 的分数从 state 加回
  if (skippedSamples > 0) {
    for (const sample of loaded.samples) {
      const st = state.samples[sample.sample_id];
      if (st?.status !== "qa_done") continue;
      if (caseRows.some((r) => r.sample_id === sample.sample_id)) continue;
      const qaPath = join(runDir(runId), "qa.jsonl");
      if (!existsSync(qaPath)) continue;
      const lines = (await readFile(qaPath, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        const row = JSON.parse(line) as (typeof caseRows)[number];
        if (row.sample_id !== sample.sample_id) continue;
        if (!isScoreCategory(row.category)) continue;
        caseRows.push(row);
        const cat = scoredCats[String(row.category)];
        if (cat) {
          cat.n++;
          cat.hits += row.score;
        }
      }
    }
  }

  const n = Object.values(scoredCats).reduce((s, c) => s + c.n, 0);
  const hits = Object.values(scoredCats).reduce((s, c) => s + c.hits, 0);
  const accuracy = n === 0 ? 0 : hits / n;
  const per_category: Record<string, number> = {};
  for (const [k, v] of Object.entries(scoredCats)) {
    per_category[k] = v.n === 0 ? 0 : v.hits / v.n;
  }

  const isSample = Boolean(opts.sample);
  const ok = n >= (isSample ? 1 : 1500) && compileFailedIds.length === 0;

  const metrics = {
    protocol: "jscore-v1",
    fixture: false,
    n,
    hits,
    accuracy,
    per_category,
    dataset_url: loaded.datasetUrl,
    dataset_sha256: datasetSha,
    answerer_model: CHAT_MODEL,
    judge_model: CHAT_MODEL,
    compile_model: CHAT_MODEL,
    embedding_provider: resolved.fallback ? "local" : "openai",
    embedding_model: resolved.fallback ? "hashed-bigram-384" : EMBED_MODEL,
    embedding_fallback: resolved.fallback ? "local" : null,
    ingest_mode: ingestMode,
    concurrency,
    api_base: API_BASE,
    prompt_hash: promptHash,
    top_k: TOP_K,
    distill: false,
    tokens: {
      compile_in: tokens.compile_in,
      compile_out: tokens.compile_out,
      answer_in: tokens.answer_in,
      answer_out: tokens.answer_out,
      judge_in: tokens.judge_in,
      judge_out: tokens.judge_out,
      embed: tokens.embed,
      answer_in_per_query_p50: percentile(tokens.answer_in_per_query, 50),
    },
    latency_ms: {
      compile_p50: percentile(lat.compile, 50),
      query_p50: percentile(lat.query, 50),
      answer_p50: percentile(lat.answer, 50),
      judge_p50: percentile(lat.judge, 50),
      compile_p95: percentile(lat.compile, 95),
      query_p95: percentile(lat.query, 95),
    },
    run_id: runId,
  };

  const receiptPath = await writeReceipt({
    id: "locomo",
    kind: "adapter",
    adapter: "locomo",
    ts,
    ok,
    metrics,
    extra: {
      cases: caseRows,
      compile_failed: compileFailedIds,
      compile_errors: compileErrors,
      compile_sessions: compileSessions,
      skipped_samples: skippedSamples,
      l0_written: l0Written,
      used_compile: compileSessions > 0 || skippedSamples > 0,
      prompt_hash: promptHash,
      dataset_sha256: datasetSha,
    },
  });

  console.log(
    JSON.stringify({
      ok,
      kind: "adapter",
      adapter: "locomo",
      protocol: "jscore-v1",
      metrics,
      extra: {
        compile_failed: compileFailedIds,
        compile_errors: compileErrors,
        compile_sessions: compileSessions,
        l0_written: l0Written,
        n_cases: caseRows.length,
      },
      receipt: receiptPath,
      run_id: runId,
    }),
  );
  return 0;
}
