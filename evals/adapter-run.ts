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
  type QueryHit,
  type EmbeddingProvider,
  type DreamPhaseResult,
  type SqlClient,
} from "../packages/core/src/index.ts";
import { getAdapter } from "./adapters/registry.ts";
import { fixtureDir, cacheDir } from "./lib/paths.ts";
import { writeReceipt } from "./lib/receipt.ts";
import { createEvalWorkspace } from "./lib/workspace.ts";
import {
  evalBaselineEnabled,
  evalCompileConcurrency,
  evalDreamPhases,
  evalFullPipelineEnabled,
  evalIngestMode,
  evalQueryKind,
  evalStopAfter,
  scoreCases,
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

function makeRetrieve(
  db: SqlClient,
  opts: {
    queryKind: "hybrid" | "think";
    repoRoot: string;
    embedder?: EmbeddingProvider;
  },
): (query: string) => Promise<QueryHit[]> {
  return async (query: string) => {
    if (opts.queryKind === "think") {
      const r = await thinkQuery(db, {
        brainId: "default",
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
      brainId: "default",
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

  const full = evalFullPipelineEnabled();
  const baselineOn = full && evalBaselineEnabled();
  const queryKind = evalQueryKind();
  const dreamPhases = evalDreamPhases();
  const ingestMode = evalIngestMode();
  const stopAfter = evalStopAfter();
  const persistDir =
    process.env.DF_EVAL_WORKSPACE?.trim() ||
    (stopAfter === "ingest" ? join(process.cwd(), "evals", "workspaces", adapter.id) : undefined);
  // 默认不 reset：保留仓与分区 checkpoint，便于断点续跑。清空请显式 DF_EVAL_WORKSPACE_RESET=1
  const resetWorkspace = (process.env.DF_EVAL_WORKSPACE_RESET ?? "0").trim().toLowerCase();
  const doReset = resetWorkspace === "1" || resetWorkspace === "true" || resetWorkspace === "yes";

  const ws = await createEvalWorkspace({
    brain: "default",
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
    const planned =
      maxIngest > 0
        ? Math.min(maxIngest, new Set(cases.flatMap((c) => c.ingestTexts ?? [])).size)
        : new Set(cases.flatMap((c) => c.ingestTexts ?? [])).size;
    const step = planned > 500 ? 100 : planned > 50 ? 25 : 5;
    let compileRuns = 0;
    let keptTotal = 0;

    console.error(
      `[eval] ingest start mode=${ingestMode} (planned≈${planned}, full=${full}, query=${queryKind})`,
    );

    if (ingestMode === "compile") {
      const texts: string[] = [];
      for (const c of cases) {
        for (const text of c.ingestTexts ?? []) {
          if (ingested.has(text)) continue;
          if (maxIngest > 0 && texts.length >= maxIngest) break;
          ingested.add(text);
          texts.push(text);
        }
        if (maxIngest > 0 && texts.length >= maxIngest) break;
      }
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
        const sessionId = `evalp${range.part}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        console.error(
          `[eval] part ${range.part} resume next=${cp.next}/${range.end} session=${sessionId}`,
        );
        for (let i = cp.next; i < range.end; i++) {
          const text = texts[i]!;
          const appended = await appendSessionTurns({
            repoRoot: ws.repoRoot,
            brainId: "default",
            sourceId: "default",
            createdBy: `eval:${adapter.id}:p${range.part}`,
            pack: ws.pack,
            queue: ws.queue,
            turns: [{ role: "user", text }],
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
          } else if (progress.turns % step === 0) {
            console.error(
              `[eval] part ${range.part} buffered i=${i} open=${appended.buffered_turns}`,
            );
          }
        }
        try {
          const flushed = await endSession({
            repoRoot: ws.repoRoot,
            brainId: "default",
            sourceId: "default",
            createdBy: `eval:${adapter.id}:p${range.part}`,
            pack: ws.pack,
            queue: ws.queue,
            sessionId,
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
            `[eval] part ${range.part} endSession kept=${flushed.kept.length} errors=${flushed.errors.length}`,
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
        for (const text of c.ingestTexts ?? []) {
          if (ingested.has(text)) continue;
          if (maxIngest > 0 && ingested.size >= maxIngest) {
            ingestDone = true;
            break;
          }
          ingested.add(text);
          const title = text.slice(0, 80);
          await captureNode(ws.repoRoot, ws.pack, ws.queue, {
            brainId: "default",
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
        await syncAll(conn.db, ws.repoRoot, "default");
        if (baselineOn) {
          console.error("[eval] baseline query …");
          baseline = await scoreCases({
            adapter,
            cases,
            repoRoot: ws.repoRoot,
            retrieve: makeRetrieve(conn.db, {
              queryKind,
              repoRoot: ws.repoRoot,
              embedder: queryEmbedder,
            }),
          });
          console.error(`[eval] baseline accuracy=${baseline.accuracy}`);
        }
      } finally {
        await conn.close();
      }
    }

    let dreamSummary: ReturnType<typeof summarizeDream> | undefined;
    let contradictionList = 0;
    if (full) {
      console.error(`[eval] dream phases=${dreamPhases.join(",")} …`);
      const dream = await runDream(ws.repoRoot, {
        brainId: "default",
        queue: ws.queue,
        phases: dreamPhases,
        embedder: dreamEmbedder,
      });
      dreamSummary = summarizeDream(dream.phases);
      console.error(
        `[eval] dream done distill.written=${dreamSummary.distill.written} contra.cross=${dreamSummary.contradictions.cross_file}`,
      );
      try {
        contradictionList = (await listContradictions(ws.repoRoot, "default")).length;
      } catch {
        contradictionList = 0;
      }
    }

    const conn = await openPglite(ws.repoRoot);
    try {
      // hooks 已增量索引；再 syncAll 做内容未变短接 / 补漏。
      await syncAll(conn.db, ws.repoRoot, "default");
      console.error("[eval] final query …");
      const final = await scoreCases({
        adapter,
        cases,
        repoRoot: ws.repoRoot,
        retrieve: makeRetrieve(conn.db, {
          queryKind,
          repoRoot: ws.repoRoot,
          embedder: queryEmbedder,
        }),
      });
      const ok = final.accuracy >= 1;
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
        retrieval: {
          final: { hits: final.hits, accuracy: final.accuracy },
          ...(baseline
            ? {
                baseline: { hits: baseline.hits, accuracy: baseline.accuracy },
                lift: final.accuracy - baseline.accuracy,
              }
            : {}),
        },
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
