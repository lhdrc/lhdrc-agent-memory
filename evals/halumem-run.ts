import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  captureNode,
  compileSession,
  createLLMProvider,
  hybridQuery,
  isEnvMockCompleteEnabled,
  LocalHashEmbedding,
  loadRepoConfig,
  ErrorCodes,
  openPglite,
  readNode,
  resolveEmbedder,
  type CompileResult,
  type EmbeddingProvider,
  type LLMProvider,
  type QueryHit,
} from "../packages/core/src/index.ts";
import {
  HALUMEM_MEDIUM_URL,
  isInterference,
  isTruthyUpdate,
  loadHaluMemJsonl,
  memoryIntegrityHit,
  selectHaluMemSessions,
  turnsFromHaluMemDialogue,
  type HaluMemMemoryPoint,
  type HaluMemQuestion,
  type HaluMemSession,
  type HaluMemUser,
} from "./adapters/halumem.ts";
import {
  formatAnswerPrompt,
  formatJudgePrompt,
  locomoPromptHash,
  parseJudgeVerdict,
} from "./adapters/locomo-prompts.ts";
import { cacheDir, fixtureDir } from "./lib/paths.ts";
import {
  API_BASE,
  CHAT_MODEL,
  EMBED_DIMS,
  EMBED_MODEL,
  evalKeyEnv,
  hasEvalKey,
  patchPublishYml,
  percentile,
} from "./lib/publish-env.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";

const TOP_K = 5;
const MISSING =
  "HaluMem 数据未准备。请 --fixture 跑仓内样例，或 memory eval fetch --adapter halumem --allow-net";

export interface HaluMemRunOpts {
  fixture?: boolean;
  user?: string;
  json?: boolean;
  concurrency?: number;
  maxSessions?: number;
  continueOnCompileError?: boolean;
  allowHashEmbed?: boolean;
  ingest?: "compile" | "capture";
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

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

function mockEmbedder(): EmbeddingProvider {
  const inner = new LocalHashEmbedding(384);
  return { id: "openai", dims: 384, embed: (texts) => inner.embed(texts) };
}

async function keptToBlob(
  repoRoot: string,
  brainId: string,
  kept: CompileResult["kept"],
): Promise<string> {
  const parts: string[] = [];
  for (const k of kept) {
    parts.push(k.title);
    if (k.path) {
      try {
        const node = await readNode(repoRoot, brainId, k.path, { layer: "l0" });
        parts.push(node.content);
      } catch {
        /* skip */
      }
    }
  }
  return parts.join("\n");
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
    judgeDistill: (a, b) => inner.judgeDistill(a, b),
    generateAbstract: (c) => inner.generateAbstract(c),
    generateOverview: (c) => inner.generateOverview(c),
    refineExperience: (c) => inner.refineExperience(c),
    extractFacts: inner.extractFacts ? (b, m) => inner.extractFacts!(b, m) : undefined,
  };
}

async function resolveHaluMemData(opts: HaluMemRunOpts): Promise<{
  users: HaluMemUser[];
  sourcePath: string;
  datasetUrl: string;
}> {
  const cached = join(cacheDir("halumem"), "HaluMem-Medium.jsonl");
  const fixturePath = join(fixtureDir("halumem-sample"), "sample.jsonl");
  if (opts.fixture && existsSync(fixturePath)) {
    const users = await loadHaluMemJsonl(fixturePath, opts.user ?? "fixture-user-0");
    return { users, sourcePath: fixturePath, datasetUrl: `fixture:${fixturePath}` };
  }
  if (existsSync(cached)) {
    const users = await loadHaluMemJsonl(cached, opts.user);
    const list = opts.user ? users : opts.fixture ? users.slice(0, 1) : users;
    return { users: list, sourcePath: cached, datasetUrl: HALUMEM_MEDIUM_URL };
  }
  if (opts.fixture && existsSync(fixturePath)) {
    const users = await loadHaluMemJsonl(fixturePath, opts.user ?? "fixture-user-0");
    return { users, sourcePath: fixturePath, datasetUrl: `fixture:${fixturePath}` };
  }
  throw new Error(MISSING);
}

function scoreExtractSession(
  extractedBlob: string,
  memoryPoints: HaluMemMemoryPoint[],
): { integrity: { n: number; hits: number }; update: { n: number; hits: number } } {
  const integrity = { n: 0, hits: 0 };
  const update = { n: 0, hits: 0 };
  for (const mp of memoryPoints) {
    if (isInterference(mp)) continue;
    if (isTruthyUpdate(mp.is_update)) {
      update.n++;
      if (memoryIntegrityHit(extractedBlob, mp.memory_content)) update.hits++;
    } else {
      integrity.n++;
      if (memoryIntegrityHit(extractedBlob, mp.memory_content)) integrity.hits++;
    }
  }
  return { integrity, update };
}

function captureSessionBlob(sess: HaluMemSession): string {
  return sess.dialogue
    .map((d) => String(d.content ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

async function ingestHaluMemCapture(
  ws: Awaited<ReturnType<typeof createEvalWorkspace>>,
  user: HaluMemUser,
  sessions: HaluMemSession[],
): Promise<{ sessions: number; notes: number }> {
  let noteCount = 0;
  for (const sess of sessions) {
    let n = 0;
    for (const d of sess.dialogue) {
      const text = String(d.content ?? "").trim();
      if (!text) continue;
      n++;
      await captureNode(ws.repoRoot, ws.pack, ws.queue, {
        brainId: "default",
        sourceId: "default",
        schemaType: "note",
        title: `${user.uuid.slice(0, 8)}-s${sess.session_index}-t${n}`,
        body: text,
        createdBy: `eval:halumem:capture:${user.uuid}`,
      });
      noteCount++;
    }
  }
  return { sessions: sessions.length, notes: noteCount };
}

function scoreExtractFromSessions(
  sessions: HaluMemSession[],
  onSession: (sess: HaluMemSession, blob: string) => void,
): void {
  for (const sess of sessions) {
    onSession(sess, captureSessionBlob(sess));
  }
}

export async function runHaluMemPublish(opts: HaluMemRunOpts): Promise<number> {
  let loaded: { users: HaluMemUser[]; sourcePath: string; datasetUrl: string };
  try {
    loaded = await resolveHaluMemData(opts);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (loaded.users.length === 0) {
    console.error("HaluMem 无 user。请检查 --user / --fixture");
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
    console.error(`embedding 无 Key（${keyEnv}）。调试可加 --allow-hash-embed`);
    return 1;
  }

  const llmEnabled = isEnvMockCompleteEnabled() || hasEvalKey(keyEnv);
  if (!llmEnabled) {
    console.error(`缺少 API Key（${keyEnv}）。HaluMem compile/QA 需要 Key 或 mock`);
    return 1;
  }

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1) || 1);
  const ingestMode = opts.ingest ?? "compile";
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
  };
  const lat = { compile: [] as number[], query: [] as number[], answer: [] as number[], judge: [] as number[] };

  let integrityN = 0;
  let integrityHits = 0;
  let updateN = 0;
  let updateHits = 0;
  let qaN = 0;
  let qaHits = 0;
  const extractRows: Array<{ session: number; memory_content: string; hit: number; kind: string }> = [];
  const qaRows: Array<{ id: string; question: string; score: number; predicted: string; verdict: string }> = [];
  let compileSessions = 0;
  let ingestNotes = 0;
  let compileErrors = 0;
  let l0Written = 0;
  let compileFailed = false;
  const continueOnCompileError =
    opts.continueOnCompileError ?? opts.maxSessions != null;

  for (const user of loaded.users) {
    const picked = selectHaluMemSessions(user.sessions, opts.maxSessions);
    const capNote = picked.capped ? ` max_sessions=${opts.maxSessions}/${picked.eligible}` : "";
    console.log(
      `[progress] user ${user.uuid} sessions=${picked.sessions.length}${capNote} ingest=${ingestMode}`,
    );
    const ws = await createEvalWorkspace({ brain: "default", git: "off" });
    try {
      await patchPublishYml(ws.repoRoot, keyEnv);
      const cfg = await loadRepoConfig(ws.repoRoot);
      const llm = wrapLlm(
        createLLMProvider(cfg.llm, {
          repoRoot: ws.repoRoot,
          cost: cfg.cost,
          timeoutMs: Number(process.env.DF_EVAL_COMPLETE_TIMEOUT_MS ?? 180_000) || 180_000,
        }),
        tokens,
      );
      const embedder = resolved.embedder;
      const allQuestions: Array<{ qa: HaluMemQuestion; sid: number }> = [];
      const ingestedSessions: HaluMemSession[] = [];

      if (ingestMode === "capture") {
        const t0 = Date.now();
        try {
          const r = await ingestHaluMemCapture(ws, user, picked.sessions);
          compileSessions += r.sessions;
          ingestNotes += r.notes;
          lat.compile.push(Date.now() - t0);
          ingestedSessions.push(...picked.sessions);
        } catch (e) {
          compileFailed = true;
          compileErrors++;
          lat.compile.push(Date.now() - t0);
          console.error(`capture ingest failed:`, e instanceof Error ? e.message : e);
        }
        if (ingestedSessions.length > 0) {
          scoreExtractFromSessions(ingestedSessions, (sess, blob) => {
            const ex = scoreExtractSession(blob, sess.memory_points);
            integrityN += ex.integrity.n;
            integrityHits += ex.integrity.hits;
            updateN += ex.update.n;
            updateHits += ex.update.hits;
            for (const mp of sess.memory_points) {
              if (isInterference(mp)) continue;
              const kind = isTruthyUpdate(mp.is_update) ? "update" : "integrity";
              extractRows.push({
                session: sess.session_index,
                memory_content: mp.memory_content.slice(0, 120),
                hit: memoryIntegrityHit(blob, mp.memory_content) ? 1 : 0,
                kind,
              });
            }
            if (sess.questions?.length) {
              for (const qa of sess.questions) allQuestions.push({ qa, sid: sess.session_index });
            }
          });
        }
      } else for (const sess of picked.sessions) {
        const t0 = Date.now();
        let result: CompileResult;
        try {
          result = await compileSession({
            repoRoot: ws.repoRoot,
            brainId: "default",
            sourceId: "default",
            createdBy: `eval:halumem:${user.uuid}`,
            pack: ws.pack,
            queue: ws.queue,
            turns: turnsFromHaluMemDialogue(sess.dialogue),
            llm,
          });
          compileSessions++;
          lat.compile.push(Date.now() - t0);
          if (result.errors.some((e) => e.code === ErrorCodes.DISABLED)) {
            compileFailed = true;
            break;
          }
        } catch (e) {
          compileFailed = true;
          compileErrors++;
          lat.compile.push(Date.now() - t0);
          console.error(`compile failed session ${sess.session_index}:`, e instanceof Error ? e.message : e);
          if (!continueOnCompileError) break;
          continue;
        }

        const extractedBlob = await keptToBlob(ws.repoRoot, "default", result.kept);
        const ex = scoreExtractSession(extractedBlob, sess.memory_points);
        integrityN += ex.integrity.n;
        integrityHits += ex.integrity.hits;
        updateN += ex.update.n;
        updateHits += ex.update.hits;
        for (const mp of sess.memory_points) {
          if (isInterference(mp)) continue;
          const kind = isTruthyUpdate(mp.is_update) ? "update" : "integrity";
          extractRows.push({
            session: sess.session_index,
            memory_content: mp.memory_content.slice(0, 120),
            hit: memoryIntegrityHit(extractedBlob, mp.memory_content) ? 1 : 0,
            kind,
          });
        }
        if (sess.questions?.length) {
          for (const qa of sess.questions) allQuestions.push({ qa, sid: sess.session_index });
        }
      }

      l0Written += await countL0(ws.repoRoot, "default");

      if (compileSessions === 0) {
        console.log(`[progress] user ${user.uuid} ingest_failed l0=${l0Written} errors=${compileErrors}`);
        continue;
      }
      if (compileErrors > 0) {
        console.log(
          `[progress] user ${user.uuid} compile_partial ok=${compileSessions} err=${compileErrors} l0=${l0Written}`,
        );
      }

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

        for (let i = 0; i < allQuestions.length; i += concurrency) {
          const chunk = allQuestions.slice(i, i + concurrency);
          const results = await Promise.all(
            chunk.map(async ({ qa, sid }, qi) => {
              const q0 = Date.now();
              const hits = await withQuery(() =>
                hybridQuery(conn.db, {
                  brainId: "default",
                  query: qa.question,
                  skipCache: true,
                  limit: TOP_K,
                  mode: "balanced",
                  embedder,
                  repoRoot: ws.repoRoot,
                  excludeSchemaTypes: ["skill"],
                  excludeSidecars: true,
                }),
              );
              lat.query.push(Date.now() - q0);
              const ansP = formatAnswerPrompt(qa.question, memoriesBlob(hits));
              const a0 = Date.now();
              const ans = await llm.complete({ purpose: "other", system: ansP.system, prompt: ansP.prompt });
              lat.answer.push(Date.now() - a0);
              tokens.answer_in += ans.usage?.prompt_tokens ?? 0;
              tokens.answer_out += ans.usage?.completion_tokens ?? 0;
              const predicted = String(ans.text ?? "").trim();
              const jP = formatJudgePrompt(qa.question, goldText(qa.answer), predicted);
              const j0 = Date.now();
              const judged = await llm.complete({ purpose: "other", system: jP.system, prompt: jP.prompt });
              lat.judge.push(Date.now() - j0);
              tokens.judge_in += judged.usage?.prompt_tokens ?? 0;
              tokens.judge_out += judged.usage?.completion_tokens ?? 0;
              const verdict = parseJudgeVerdict(judged.text);
              const score = verdict === "CORRECT" ? 1 : 0;
              return {
                id: `${user.uuid}-s${sid}-q${i + qi}`,
                question: qa.question,
                score,
                predicted,
                verdict,
              };
            }),
          );
          for (const r of results) {
            qaRows.push(r);
            qaN++;
            qaHits += r.score;
          }
        }
      } finally {
        await conn.close();
      }
    } finally {
      await ws.dispose();
    }
  }

  const integrityRecall = integrityN === 0 ? 0 : integrityHits / integrityN;
  const updateAcc = updateN === 0 ? 0 : updateHits / updateN;
  const qaAcc = qaN === 0 ? 0 : qaHits / qaN;

  const isFixture = Boolean(opts.fixture);
  const capped = opts.maxSessions != null;
  const minIntegrity = isFixture || capped ? 1 : 10;
  const ok =
    ingestMode === "capture"
      ? compileSessions > 0 && qaN >= 1
      : !compileFailed && integrityN >= minIntegrity && qaN >= 1;

  const metrics = {
    protocol: "halumem-v1",
    fixture: isFixture,
    split: "medium",
    ingest_mode: ingestMode,
    max_sessions: opts.maxSessions ?? null,
    dataset_url: loaded.datasetUrl,
    dataset_sha256: datasetSha,
    compile_model: CHAT_MODEL,
    answerer_model: CHAT_MODEL,
    judge_model: CHAT_MODEL,
    embedding_provider: resolved.fallback ? "local" : "openai",
    embedding_model: resolved.fallback ? "hashed-bigram-384" : EMBED_MODEL,
    embedding_fallback: resolved.fallback ? "local" : null,
    api_base: API_BASE,
    prompt_hash: promptHash,
    top_k: TOP_K,
    extract: {
      integrity_n: integrityN,
      integrity_hits: integrityHits,
      integrity_recall: integrityRecall,
      update_n: updateN,
      update_hits: updateHits,
      update_accuracy: updateAcc,
    },
    qa: { n: qaN, hits: qaHits, accuracy: qaAcc },
    tokens,
    latency_ms: {
      compile_p50: percentile(lat.compile, 50),
      query_p50: percentile(lat.query, 50),
      answer_p50: percentile(lat.answer, 50),
      judge_p50: percentile(lat.judge, 50),
    },
    users: loaded.users.length,
    compile_sessions: compileSessions,
    ingest_notes: ingestMode === "capture" ? ingestNotes : null,
    compile_errors: compileErrors,
    continue_on_compile_error: continueOnCompileError,
    l0_written: l0Written,
  };

  const receiptPath = await writeReceipt({
    id: "halumem",
    kind: "adapter",
    adapter: "halumem",
    ts,
    ok,
    metrics,
    extra: {
      extract_rows: extractRows,
      qa_rows: qaRows,
      compile_failed: compileFailed,
      compile_errors: compileErrors,
      continue_on_compile_error: continueOnCompileError,
      max_sessions: opts.maxSessions ?? null,
      ingest_mode: ingestMode,
      ingest_notes: ingestMode === "capture" ? ingestNotes : null,
    },
  });

  console.log(
    JSON.stringify({
      ok,
      kind: "adapter",
      adapter: "halumem",
      protocol: "halumem-v1",
      metrics,
      receipt: receiptPath,
    }),
  );
  return compileFailed && !continueOnCompileError ? 1 : compileSessions === 0 ? 1 : 0;
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
