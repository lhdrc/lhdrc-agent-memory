import {
  captureNode,
  openPglite,
  hybridQuery,
  thinkQuery,
  syncAll,
  runDream,
  listContradictions,
  resolveEmbedder,
  loadRepoConfig,
  appendSessionTurns,
  endSession,
  assertRememberCompileReady,
  createLLMProvider,
  type QueryHit,
  type EmbeddingProvider,
  type DreamPhaseResult,
  type SqlClient,
} from "../packages/core/src/index.ts";
import { getAdapter } from "./adapters/registry.ts";
import { retrieveLocomoStage } from "./lib/locomo-retrieve.ts";
import { extractDiaIds, scoreLocomo, type LocomoCaseScoreInput } from "./lib/locomo-score.ts";
import { hitsToEvalBlob } from "./lib/rule-agent.ts";
import { fixtureDir, cacheDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import type { EvalAdapter, EvalCase } from "./adapters/types.ts";
import {
  evalBaselineEnabled,
  evalCompileConcurrency,
  evalDreamPhases,
  evalFullPipelineEnabled,
  evalIngestMode,
  evalQueryKind,
  evalStopAfter,
  hasEvalLlmKey,
  scoreCasesWithAnswer,
  type AnswerFn,
} from "./lib/pipeline.ts";
import {
  loadOrInitManifest,
  loadPartCheckpoint,
  partitionRanges,
  savePartCheckpoint,
} from "./lib/ingest-checkpoint.ts";
import { join } from "node:path";

function summarizeDream(phases: DreamPhaseResult[]): {
  distill: Record<string, unknown>;
  contradictions: Record<string, unknown>;
  phases: Array<{
    phase: number;
    name: string;
    ok: boolean;
    skipped?: boolean;
    reason?: string;
    details?: Record<string, unknown>;
  }>;
} {
  const distillPhase = phases.find((p) => p.name === "distill_pending");
  const contraPhase = phases.find((p) => p.name === "contradictions");
  return {
    distill: {
      skipped: Boolean(distillPhase?.skipped),
      reason: distillPhase?.reason ?? distillPhase?.details?.reason,
      written: distillPhase?.details?.written ?? 0,
      distill_skipped: distillPhase?.details?.skipped,
      crystallized: distillPhase?.details?.crystallized,
    },
    contradictions: {
      intra: contraPhase?.details?.findings ?? 0,
      cross_file: contraPhase?.details?.cross_file ?? 0,
      truncated: contraPhase?.details?.truncated === true,
    },
    phases: phases.map((p) => ({
      phase: p.phase,
      name: p.name,
      ok: p.ok,
      skipped: p.skipped,
      reason: p.reason,
      details: p.details,
    })),
  };
}

function brainFor(c: { meta?: Record<string, unknown> }): string {
  const b = c.meta?.brain;
  return typeof b === "string" && b.length > 0 ? b : "default";
}

async function scoreGrouped(opts: {
  adapter: EvalAdapter;
  cases: EvalCase[];
  repoRoot: string;
  retrieveFor: (brain: string) => (query: string) => Promise<QueryHit[]>;
  complete?: AnswerFn;
}): Promise<{
  hits: number;
  accuracy: number;
  rows: Array<{ id: string; score: number; layers: Record<string, number>; answer?: string }>;
  layers: Record<string, number>;
  answerMode: "llm" | "rule";
  judge: "llm" | "rule";
}> {
  const groups = new Map<string, EvalCase[]>();
  for (const c of opts.cases) {
    const b = brainFor(c);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(c);
  }
  let hits = 0;
  const rows: Array<{ id: string; score: number; layers: Record<string, number>; answer?: string }> = [];
  const layers: Record<string, number> = {};
  let answerMode: "llm" | "rule" = "rule";
  let judge: "llm" | "rule" = "rule";
  for (const [b, cs] of groups) {
    const r = await scoreCasesWithAnswer({
      adapter: opts.adapter,
      cases: cs,
      repoRoot: opts.repoRoot,
      brainId: b,
      retrieve: opts.retrieveFor(b),
      complete: opts.complete,
    });
    hits += r.hits;
    rows.push(...r.rows);
    answerMode = r.answerMode;
    judge = r.judge;
    for (const [k, n] of Object.entries(r.layers)) layers[k] = (layers[k] ?? 0) + n;
  }
  const n = opts.cases.length;
  return { hits, accuracy: n === 0 ? 0 : hits / n, rows, layers, answerMode, judge };
}

/** locomo 分阶段检索运行器：stage1 miss 才回跳 history / 加 experiences+skills。 */
function makeLocomoStagedRunner(repoRoot: string) {
  const stats: Array<{ id: string; brain: string; stages: string[]; historyExpanded: number; arms: Record<string, number>; diaIds: string[]; text: string }> = [];
  let byId = new Map<string, EvalCase>();
  const pending = new Map<string, string[]>();
  return {
    stats,
    reset(cases: EvalCase[]) {
      stats.length = 0;
      byId = new Map(cases.map((c) => [c.id, c]));
      pending.clear();
      for (const c of cases) {
        const k = `${brainFor(c)}\n${c.query}`;
        if (!pending.has(k)) pending.set(k, []);
        pending.get(k)!.push(c.id);
      }
    },
    retrieveFor(db: SqlClient, embedder: EmbeddingProvider | undefined) {
      return (b: string) => async (query: string): Promise<QueryHit[]> => {
        const k = `${b}\n${query}`;
        const id = pending.get(k)?.shift() ?? `${b}:${query}`;
        const c = byId.get(id);
        const r = await retrieveLocomoStage(
          db,
          { brainId: b, repoRoot, embedder },
          query,
          c?.gold ?? "",
          (hits) => hitsToEvalBlob(repoRoot, hits),
        );
        stats.push({ id, brain: b, stages: r.stages, historyExpanded: r.historyExpanded, arms: r.arms, diaIds: extractDiaIds(r.hits), text: r.hits.map((h) => `${h.title ?? ""}\n${h.snippet ?? ""}`).join("\n") });
        return r.hits;
      };
    },
  };
}

function summarizeStaging(
  stats: Array<{ stages: string[]; historyExpanded: number; arms: Record<string, number> }>,
): Record<string, unknown> {
  const histogram: Record<string, number> = {};
  let expanded = 0;
  const armsTotal: Record<string, number> = {};
  for (const s of stats) {
    const k = s.stages.join("+");
    histogram[k] = (histogram[k] ?? 0) + 1;
    expanded += s.historyExpanded;
    for (const [ak, av] of Object.entries(s.arms)) armsTotal[ak] = (armsTotal[ak] ?? 0) + av;
  }
  return {
    stage_histogram: histogram,
    history_expand_rate: stats.length === 0 ? 0 : expanded / stats.length,
    arms_total: armsTotal,
  };
}

function makeRetrieve(
  db: SqlClient,
  opts: {
    queryKind: "hybrid" | "think";
    repoRoot: string;
    brainId: string;
    embedder?: EmbeddingProvider;
  },
): (query: string) => Promise<QueryHit[]> {
  return async (query: string) => {
    if (opts.queryKind === "think") {
      const r = await thinkQuery(db, {
        brainId: opts.brainId,
        query,
        limit: 10,
        repoRoot: opts.repoRoot,
        embedder: opts.embedder,
      });
      const flat = [...r.skills, ...r.experiences, ...r.notes];
      return flat.map((h) => ({
        path: h.path,
        title: h.title,
        score: h.score,
        snippet: h.snippet,
        evidence: [] as string[],
      }));
    }
    return hybridQuery(db, {
      brainId: opts.brainId,
      query,
      skipCache: true,
      limit: 10,
      repoRoot: opts.repoRoot,
      embedder: opts.embedder,
    });
  };
}

export async function runAdapter(opts: {
  adapter: string;
  fixture?: boolean;
  json?: boolean;
}): Promise<number> {
  const adapter = getAdapter(opts.adapter);
  const cases = await adapter.load({
    fixture: Boolean(opts.fixture),
    fixtureDir: fixtureDir(`${opts.adapter}-sample`),
    cacheDir: cacheDir(opts.adapter),
  });
  if (cases.length === 0) {
    throw new Error(`${adapter.id} 无 case。请使用 --fixture 或 fetch --allow-net`);
  }
  const caseBrains = [...new Set(cases.map(brainFor))];

  const full = evalFullPipelineEnabled();
  const baselineOn = full && evalBaselineEnabled();
  const queryKind = evalQueryKind();
  const dreamPhases = evalDreamPhases();
  const ingestMode = evalIngestMode();
  const stopAfter = evalStopAfter();
  // 默认落盘到 evals/workspaces/<adapter> 便于复查；默认 reset 保证干净可复现。
  // 自定义 DF_EVAL_WORKSPACE 时沿旧语义：默认续跑，DF_EVAL_WORKSPACE_RESET=1 才清空。
  const customDir = process.env.DF_EVAL_WORKSPACE?.trim();
  const persistDir = customDir || join(process.cwd(), "evals", "workspaces", adapter.id);
  const resetRaw = (process.env.DF_EVAL_WORKSPACE_RESET ?? "").trim().toLowerCase();
  const doReset = customDir
    ? resetRaw === "1" || resetRaw === "true" || resetRaw === "yes"
    : !(resetRaw === "0" || resetRaw === "false" || resetRaw === "no");

  const ws = await createEvalWorkspace({
    brain: "default",
    extraBrains: caseBrains.filter((b) => b !== "default"),
    persistDir,
    reset: Boolean(persistDir) && doReset,
  });
  if (persistDir) {
    console.error(`[eval] workspace ${ws.repoRoot} (reset=${doReset})`);
  }
  const ts = new Date().toISOString();
  try {
    const cfgEarly = await loadRepoConfig(ws.repoRoot);
    if (ingestMode === "compile") {
      assertRememberCompileReady(cfgEarly.llm, false);
    }

    const ingested = new Set<string>();
    const maxIngest = Number.parseInt(process.env.DF_EVAL_MAX_INGEST ?? "0", 10);
    let ingestDone = false;
    // brain+text 去重：同文本跨 brain 互不吞并（locomo 每会话独立 brain）。
    const allPairs: Array<{ brain: string; text: string }> = [];
    {
      const seen = new Set<string>();
      for (const c of cases) {
        const b = brainFor(c);
        for (const text of c.ingestTexts ?? []) {
          const k = `${b}\n${text}`;
          if (seen.has(k)) continue;
          seen.add(k);
          allPairs.push({ brain: b, text });
        }
      }
    }
    const planned = maxIngest > 0 ? Math.min(maxIngest, allPairs.length) : allPairs.length;
    const step = planned > 500 ? 100 : planned > 50 ? 25 : 5;
    let compileRuns = 0;
    let keptTotal = 0;

    console.error(
      `[eval] ingest start mode=${ingestMode} (planned≈${planned}, full=${full}, query=${queryKind})`,
    );

    if (ingestMode === "compile") {
      const texts = maxIngest > 0 ? allPairs.slice(0, maxIngest) : allPairs;
      for (const t of texts) ingested.add(`${t.brain}\n${t.text}`);
      const concurrency = evalCompileConcurrency();
      const ranges = partitionRanges(texts.length, concurrency);
      const ckReset = doReset;
      await loadOrInitManifest(ws.repoRoot, {
        adapter: adapter.id,
        total: texts.length,
        concurrency,
        reset: ckReset,
      });
      console.error(
        `[eval] compile partitions=${ranges.length} texts=${texts.length} reset=${ckReset}`,
      );
      for (const r of ranges) {
        console.error(`[eval]   part ${r.part}: [${r.start}, ${r.end}) size=${r.end - r.start}`);
      }

      const progress = { turns: 0, compiles: 0, kept: 0 };
      const workers = ranges.map(async (range) => {
        let cp = await loadPartCheckpoint(ws.repoRoot, range, ckReset);
        if (cp.done || cp.next >= range.end) {
          console.error(`[eval] part ${range.part} already done next=${cp.next}`);
          return;
        }
        // 窗口 compile 后 core 会把 session 标 done，后续 turns 必须换新 session（否则 CONFLICT 已结束）。
        // session 按 brain 独立（同 id 跨 brain 落不同目录），用表分别跟踪。
        const newSession = () =>
          `evalp${range.part}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const sessionByBrain = new Map<string, string>();
        console.error(
          `[eval] part ${range.part} resume next=${cp.next}/${range.end}`,
        );
        for (let i = cp.next; i < range.end; i++) {
          const item = texts[i]!;
          let sessionId = sessionByBrain.get(item.brain);
          if (!sessionId) {
            sessionId = newSession();
            sessionByBrain.set(item.brain, sessionId);
          }
          const appended = await appendSessionTurns({
            repoRoot: ws.repoRoot,
            brainId: item.brain,
            sourceId: "default",
            createdBy: `eval:${adapter.id}:p${range.part}`,
            pack: ws.pack,
            queue: ws.queue,
            turns: [{ role: "user", text: item.text }],
            window: true,
            sessionId,
            bindOpen: false,
          });
          progress.turns += 1;
          if (appended.compiled) {
            cp = {
              ...cp,
              next: i + 1,
              compiles: cp.compiles + 1,
              kept: cp.kept + appended.compiled.kept.length,
              done: false,
              updated_at: new Date().toISOString(),
            };
            await savePartCheckpoint(ws.repoRoot, cp);
            progress.compiles += 1;
            progress.kept += appended.compiled.kept.length;
            if (appended.compiled.errors.length) {
              console.error(
                `[eval] part ${range.part} compile errors: ${appended.compiled.errors.join("; ")}`,
              );
            }
            console.error(
              `[eval] part ${range.part} compiled kept=${appended.compiled.kept.length} next=${cp.next}/${range.end} global_turns≈${progress.turns}`,
            );
            // 该 brain 的 session 已 done，换新 session 继续。
            sessionByBrain.set(item.brain, newSession());
          } else if (progress.turns % step === 0) {
            console.error(
              `[eval] part ${range.part} buffered i=${i} open=${appended.buffered_turns}`,
            );
          }
        }
        for (const [b, sid] of sessionByBrain) {
          try {
            const flushed = await endSession({
              repoRoot: ws.repoRoot,
              brainId: b,
              sourceId: "default",
              createdBy: `eval:${adapter.id}:p${range.part}`,
              pack: ws.pack,
              queue: ws.queue,
              sessionId: sid,
            });
            cp = {
              ...cp,
              next: range.end,
              compiles: cp.compiles + 1,
              kept: cp.kept + flushed.kept.length,
              done: true,
              updated_at: new Date().toISOString(),
            };
            await savePartCheckpoint(ws.repoRoot, cp);
            progress.compiles += 1;
            progress.kept += flushed.kept.length;
            console.error(
              `[eval] part ${range.part} brain=${b} endSession kept=${flushed.kept.length} errors=${flushed.errors.length}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/没有打开中的滑动窗口|inbox session 已结束/.test(msg)) {
              cp = { ...cp, next: range.end, done: true, updated_at: new Date().toISOString() };
              await savePartCheckpoint(ws.repoRoot, cp);
            } else {
              await savePartCheckpoint(ws.repoRoot, cp);
              throw e;
            }
          }
        }
      });
      await Promise.all(workers);
      compileRuns = progress.compiles;
      keptTotal = progress.kept;
      console.error(
        `[eval] ingest done mode=compile turns≈${progress.turns} compile_runs=${compileRuns} kept=${keptTotal} partitions=${ranges.length}`,
      );
    } else {
      for (const c of cases) {
        if (ingestDone) break;
        const b = brainFor(c);
        for (const text of c.ingestTexts ?? []) {
          const k = `${b}\n${text}`;
          if (ingested.has(k)) continue;
          if (maxIngest > 0 && ingested.size >= maxIngest) {
            ingestDone = true;
            break;
          }
          ingested.add(k);
          const title = text.slice(0, 80);
          await captureNode(ws.repoRoot, ws.pack, ws.queue, {
            brainId: b,
            sourceId: "default",
            schemaType: "note",
            title,
            body: text,
            createdBy: `eval:${adapter.id}`,
          });
          if (ingested.size % step === 0 || ingested.size === planned) {
            console.error(`[eval] ingested ${ingested.size}/${planned}`);
          }
        }
      }
      console.error(`[eval] ingest done mode=capture count=${ingested.size}`);
    }

    if (stopAfter === "ingest") {
      const metrics: Record<string, unknown> = {
        fixture: Boolean(opts.fixture),
        pipeline: "ingest_only",
        ingest_mode: ingestMode,
        ingest_count: ingested.size,
        workspace: ws.repoRoot,
        ...(ingestMode === "compile"
          ? { compile_runs: compileRuns, kept: keptTotal, concurrency: evalCompileConcurrency() }
          : {}),
      };
      const receiptPath = await writeReceipt({
        id: adapter.id,
        kind: "adapter",
        adapter: adapter.id,
        ts,
        ok: true,
        metrics,
      });
      console.log(
        JSON.stringify({
          ok: true,
          kind: "adapter",
          adapter: adapter.id,
          metrics,
          receipt: receiptPath,
        }),
      );
      return 0;
    }

    const cfg = await loadRepoConfig(ws.repoRoot);
    const resolved = resolveEmbedder(cfg.embedding);
    const realEmbed =
      !resolved.fallback && resolved.embedder.id !== "off" ? resolved.embedder : undefined;
    const semanticOn = (() => {
      const v = (process.env.DF_EVAL_SEMANTIC ?? "0").trim().toLowerCase();
      return v === "1" || v === "on" || v === "true" || v === "yes";
    })();
    const queryEmbedder: EmbeddingProvider | undefined = semanticOn ? realEmbed : undefined;
    const dreamEmbedder: EmbeddingProvider | undefined = realEmbed;
    // 回答/判定模型：与摄入同一 muse-spark（Responses API），无 key 时回退规则评分。
    const answerComplete = (() => {
      if (!hasEvalLlmKey()) return undefined;
      if (cfg.llm.provider === "off") return undefined;
      try {
        const llm = createLLMProvider(cfg.llm, { repoRoot: ws.repoRoot });
        return (req: { prompt: string; system?: string; purpose: "other" }) => llm.complete(req);
      } catch {
        return undefined;
      }
    })();
    if (answerComplete) {
      console.error(`[eval] answer LLM ${cfg.llm.model} via ${cfg.llm.base_url}`);
    } else {
      console.error("[eval] answer LLM unavailable → rule goldHit fallback");
    }

    // locomo + hybrid：分阶段检索（stage1 miss 才 history 回跳 / 加 experiences+skills）。
    const useStaged = adapter.id === "locomo" && queryKind === "hybrid";
    const staged = makeLocomoStagedRunner(ws.repoRoot);
    const retrieveForConn = (db: SqlClient) => (b: string) =>
      useStaged
        ? staged.retrieveFor(db, queryEmbedder)(b)
        : makeRetrieve(db, { queryKind, repoRoot: ws.repoRoot, brainId: b, embedder: queryEmbedder });
    let stagingBaseline: Record<string, unknown> | undefined;
    let stagingFinal: Record<string, unknown> | undefined;

    let baseline:
      | {
          hits: number;
          accuracy: number;
          rows: Array<{ id: string; score: number; layers: Record<string, number> }>;
          layers: Record<string, number>;
        }
      | undefined;

    // 基线检索：用完即关连接，避免与 dream 写路径 hooks 双开 PGLite。
    {
      const conn = await openPglite(ws.repoRoot);
      try {
        for (const b of caseBrains) await syncAll(conn.db, ws.repoRoot, b);
        if (baselineOn) {
          console.error("[eval] baseline query …");
          if (useStaged) staged.reset(cases);
          baseline = await scoreGrouped({
            adapter,
            cases,
            repoRoot: ws.repoRoot,
            retrieveFor: retrieveForConn(conn.db),
            complete: answerComplete,
          });
          if (useStaged) stagingBaseline = summarizeStaging(staged.stats);
          console.error(`[eval] baseline accuracy=${baseline.accuracy} mode=${baseline.answerMode}`);
        }
      } finally {
        await conn.close();
      }
    }

    let dreamSummary: ReturnType<typeof summarizeDream> | undefined;
    let contradictionList = 0;
    if (full) {
      let written = 0;
      let intra = 0;
      let crossFile = 0;
      let truncated = false;
      let skipped: boolean | undefined;
      let reason: unknown;
      const phases: Array<{
        phase: number;
        name: string;
        ok: boolean;
        skipped?: boolean;
        reason?: string;
        details?: Record<string, unknown>;
        brain: string;
      }> = [];
      for (const b of caseBrains) {
        console.error(`[eval] dream brain=${b} phases=${dreamPhases.join(",")} …`);
        const dream = await runDream(ws.repoRoot, {
          brainId: b,
          queue: ws.queue,
          phases: dreamPhases,
          embedder: dreamEmbedder,
        });
        const s = summarizeDream(dream.phases);
        written += Number(s.distill.written ?? 0);
        intra += Number(s.contradictions.intra ?? 0);
        crossFile += Number(s.contradictions.cross_file ?? 0);
        truncated = truncated || s.contradictions.truncated === true;
        if (skipped === undefined) {
          skipped = Boolean(s.distill.skipped);
          reason = s.distill.reason;
        } else {
          skipped = skipped && Boolean(s.distill.skipped);
        }
        for (const p of s.phases) phases.push({ ...p, brain: b });
        console.error(
          `[eval] dream brain=${b} done distill.written=${s.distill.written} contra.cross=${s.contradictions.cross_file}`,
        );
        try {
          contradictionList += (await listContradictions(ws.repoRoot, b)).length;
        } catch {
          /* fail-open */
        }
      }
      dreamSummary = {
        distill: { skipped, reason, written },
        contradictions: { intra, cross_file: crossFile, truncated },
        phases,
      };
    }

    const conn = await openPglite(ws.repoRoot);
    try {
      // hooks 已增量索引；再 syncAll 做内容未变短接 / 补漏。
      for (const b of caseBrains) await syncAll(conn.db, ws.repoRoot, b);
      console.error("[eval] final query …");
      if (useStaged) staged.reset(cases);
      const final = await scoreGrouped({
        adapter,
        cases,
        repoRoot: ws.repoRoot,
        retrieveFor: retrieveForConn(conn.db),
        complete: answerComplete,
      });
      if (useStaged) stagingFinal = summarizeStaging(staged.stats);
      const ok = final.accuracy >= 1;
      // locomo 官方口径：F1 + R@5 + 分类表（adversarial 单列，accuracy_main 剔除 cat5）。
      let locomoScore: Record<string, unknown> | undefined;
      if (adapter.id === "locomo" && useStaged) {
        const byRowId = new Map(final.rows.map((r) => [r.id, r]));
        const byCaseId = new Map(cases.map((c) => [c.id, c]));
        const items: LocomoCaseScoreInput[] = staged.stats.map((s) => {
          const row = byRowId.get(s.id);
          const c = byCaseId.get(s.id);
          const answer = row?.answer?.trim();
          return {
            id: s.id,
            score: row?.score ?? 0,
            text: answer ? answer : s.text,
            diaIds: s.diaIds,
            gold: c?.gold ?? "",
            evidence: Array.isArray(c?.evidence) ? (c.evidence as string[]) : [],
            category: (c?.meta as Record<string, unknown> | undefined)?.category,
          };
        });
        const sum = scoreLocomo(items);
        locomoScore = { f1: sum.f1, r_at_5: sum.rAtK, by_category: sum.byCategory, accuracy_main: sum.accuracyMain };
      }
      const metrics: Record<string, unknown> = {
        n: cases.length,
        hits: final.hits,
        accuracy: final.accuracy,
        fixture: Boolean(opts.fixture),
        pipeline: full ? "ingest_dream_query" : "ingest_query",
        query: queryKind,
        ingest_count: ingested.size,
        ingest_mode: ingestMode,
        ...(ingestMode === "compile"
          ? { compile_runs: compileRuns, kept: keptTotal, concurrency: evalCompileConcurrency() }
          : {}),
        layers: final.layers,
        semantic: Boolean(queryEmbedder),
        answer_mode: final.answerMode,
        judge: final.judge,
        llm_model: answerComplete ? cfg.llm.model : undefined,
        retrieval: {
          final: { hits: final.hits, accuracy: final.accuracy },
          ...(baseline
            ? {
                baseline: { hits: baseline.hits, accuracy: baseline.accuracy },
                lift: final.accuracy - baseline.accuracy,
              }
            : {}),
        },
        ...(stagingFinal ? { staging: stagingFinal } : {}),
        ...(stagingBaseline ? { staging_baseline: stagingBaseline } : {}),
        ...(locomoScore ?? {}),
      };
      if (dreamSummary) {
        metrics.distill = dreamSummary.distill;
        metrics.contradictions = {
          ...dreamSummary.contradictions,
          listed_pairs: contradictionList,
        };
        metrics.dream_phases = dreamSummary.phases;
      }

      const receiptPath = await writeReceipt({
        id: adapter.id,
        kind: "adapter",
        adapter: adapter.id,
        ts,
        ok,
        metrics,
        extra: {
          cases: final.rows,
          ...(baseline ? { baseline_cases: baseline.rows } : {}),
        },
      });
      console.log(
        JSON.stringify({
          ok,
          kind: "adapter",
          adapter: adapter.id,
          metrics,
          receipt: receiptPath,
        }),
      );
      return ok ? 0 : 1;
    } finally {
      await conn.close();
    }
  } finally {
    await ws.dispose();
  }
}
