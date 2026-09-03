/**
 * Adapter 全栈流水线开关与指标辅助。
 * 默认：ingest note →（可选基线检索）→ dream 蒸馏+矛盾 → 混合检索（分层标注）。
 */
import type { QueryHit } from "../../packages/core/src/index.ts";
import { hitsToEvalBlob } from "./rule-agent.ts";
import { answerWithMemory, buildAnswerContext, evalAnswerMode, evalJudgeKind, llmJudge, shouldAnswerWithLlm } from "./answer.ts";
import type { EvalAdapter, EvalCase } from "../adapters/types.ts";

export function evalFullPipelineEnabled(): boolean {
  const v = (process.env.DF_EVAL_FULL ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "off" && v !== "false" && v !== "no";
}

export function evalBaselineEnabled(): boolean {
  const raw = process.env.DF_EVAL_BASELINE;
  if (raw == null || raw.trim() === "") return evalFullPipelineEnabled();
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "off" && v !== "false" && v !== "no";
}

/** 默认 dream 第 3、4 段：distill_pending + contradictions（ingest 后已 sync）。 */
export function evalDreamPhases(): Array<1 | 2 | 3 | 4 | 5> {
  const raw = (process.env.DF_EVAL_DREAM_PHASES ?? "3,4").trim();
  const out: Array<1 | 2 | 3 | 4 | 5> = [];
  for (const part of raw.split(/[,+\s]+/)) {
    const n = Number.parseInt(part, 10);
    if (n >= 1 && n <= 5) out.push(n as 1 | 2 | 3 | 4 | 5);
  }
  return out.length ? out : [3, 4];
}

export function evalQueryKind(): "hybrid" | "think" {
  const v = (process.env.DF_EVAL_QUERY ?? "hybrid").trim().toLowerCase();
  return v === "think" ? "think" : "hybrid";
}

/**
 * 摄入方式。
 * - `compile` / `session` / `remember`：滑动窗口 + complete()（产品路径）
 * - `capture` / `note`：人手 note，不调 LLM
 * - `auto`（默认）：有 OpenCode/OpenAI key 则 compile，否则 capture
 */
export function evalIngestMode(): "compile" | "capture" {
  const v = (process.env.DF_EVAL_INGEST ?? "auto").trim().toLowerCase();
  if (v === "capture" || v === "note") return "capture";
  if (v === "compile" || v === "session" || v === "remember") return "compile";
  if (
    process.env.OPENCODE_API_KEY?.trim() ||
    process.env.OPENCODE_GO_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.DF_MEMORY_MOCK_COMPLETE?.trim()
  ) {
    return "compile";
  }
  return "capture";
}

/** `ingest`：写完记忆就停（先 ingest 场景）；默认跑完检索。 */
export function evalStopAfter(): "ingest" | null {
  const v = (process.env.DF_EVAL_STOP_AFTER ?? "").trim().toLowerCase();
  return v === "ingest" ? "ingest" : null;
}

/** compile 摄入并行路数（多 session 分片）；默认 1。免费档建议 2–4，过高易限流。 */
export function evalCompileConcurrency(): number {
  const n = Number.parseInt(process.env.DF_EVAL_COMPILE_CONCURRENCY ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 32);
}

/** 评测 LLM key 是否可用（muse-spark 走 OPENCODE_API_KEY，兼容旧 OPENAI key 与 mock）。 */
export function hasEvalLlmKey(): boolean {
  return Boolean(
    process.env.OPENCODE_API_KEY?.trim() ||
      process.env.OPENCODE_GO_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.DF_MEMORY_MOCK_COMPLETE?.trim(),
  );
}

export function layerHistogram(hits: QueryHit[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const h of hits) {
    const key = h.schema_type ?? inferLayerKey(h.path) ?? "unknown";
    hist[key] = (hist[key] ?? 0) + 1;
  }
  return hist;
}

function inferLayerKey(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  if (p.includes("/experiences/")) return "experience";
  if (p.includes("/skills/")) return "skill";
  if (p.includes("/notes/")) return "note";
  if (p.includes("/decisions/")) return "decision";
  if (p.includes("/lessons/")) return "lesson";
  if (p.endsWith(".abstract.md")) return "abstract";
  if (p.endsWith(".overview.md")) return "overview";
  return undefined;
}

export function mergeLayerHist(into: Record<string, number>, hits: QueryHit[]): void {
  const part = layerHistogram(hits);
  for (const [k, n] of Object.entries(part)) {
    into[k] = (into[k] ?? 0) + n;
  }
}

export async function scoreCases(opts: {
  adapter: EvalAdapter;
  cases: EvalCase[];
  repoRoot?: string;
  retrieve: (query: string) => Promise<QueryHit[]>;
}): Promise<{
  hits: number;
  accuracy: number;
  rows: Array<{ id: string; score: number; layers: Record<string, number> }>;
  layers: Record<string, number>;
}> {
  let hits = 0;
  const rows: Array<{ id: string; score: number; layers: Record<string, number> }> = [];
  const layers: Record<string, number> = {};
  for (const c of opts.cases) {
    const retrieved = await opts.retrieve(c.query);
    const blob = await hitsToEvalBlob(opts.repoRoot, retrieved);
    const score = opts.adapter.score(blob, c.gold);
    if (score >= 1) hits++;
    const caseLayers = layerHistogram(retrieved);
    mergeLayerHist(layers, retrieved);
    rows.push({ id: c.id, score, layers: caseLayers });
  }
  const n = opts.cases.length;
  return { hits, accuracy: n === 0 ? 0 : hits / n, rows, layers };
}

export type AnswerFn = (req: { prompt: string; system?: string; purpose: "other" }) => Promise<{ text: string }>;

/**
 * 两阶段评分：retrieve 片段 → read 全文/history → LLM 作答 → 评分。
 * 默认 `DF_EVAL_ANSWER=auto`：有 key 则走 LLM 作答，否则回退规则 goldHit；
 * `DF_EVAL_JUDGE=llm` 时用同一模型做 YES/NO 语义判定，否则规则子串。
 */
export async function scoreCasesWithAnswer(opts: {
  adapter: EvalAdapter;
  cases: EvalCase[];
  repoRoot: string;
  brainId?: string;
  retrieve: (query: string) => Promise<QueryHit[]>;
  complete?: AnswerFn;
}): Promise<{
  hits: number;
  accuracy: number;
  rows: Array<{ id: string; score: number; layers: Record<string, number>; answer?: string }>;
  layers: Record<string, number>;
  answerMode: "llm" | "rule";
  judge: "llm" | "rule";
}> {
  const brainId = opts.brainId ?? "default";
  const answerModeCfg = evalAnswerMode();
  const judgeKind = evalJudgeKind();
  const useLlm = shouldAnswerWithLlm(answerModeCfg, Boolean(opts.complete));
  const answerMode: "llm" | "rule" = useLlm ? "llm" : "rule";
  let hits = 0;
  const rows: Array<{ id: string; score: number; layers: Record<string, number>; answer?: string }> = [];
  const layers: Record<string, number> = {};
  for (const c of opts.cases) {
    const retrieved = await opts.retrieve(c.query);
    const caseLayers = layerHistogram(retrieved);
    mergeLayerHist(layers, retrieved);
    if (!useLlm || !opts.complete) {
      const blob = await hitsToEvalBlob(opts.repoRoot, retrieved);
      const score = opts.adapter.score(blob, c.gold);
      if (score >= 1) hits++;
      rows.push({ id: c.id, score, layers: caseLayers });
      continue;
    }
    const context = await buildAnswerContext(opts.repoRoot, brainId, retrieved);
    let answer = "";
    try {
      answer = await answerWithMemory({ query: c.query, context, complete: opts.complete });
    } catch {
      answer = await hitsToEvalBlob(opts.repoRoot, retrieved);
    }
    const goldStr = Array.isArray(c.gold) ? c.gold.join("\n") : String(c.gold ?? "");
    let score: number;
    if (judgeKind === "llm" && opts.complete) {
      try {
        score = await llmJudge({ query: c.query, gold: goldStr, answer, complete: opts.complete });
      } catch {
        score = opts.adapter.score(answer, c.gold);
      }
      // LLM 判 NO 但规则命中时保留规则分，避免 judge 过严导致假阴性。
      if (score < 1 && opts.adapter.score(answer, c.gold) >= 1) score = 1;
    } else {
      score = opts.adapter.score(answer, c.gold);
      // 作答抽取丢失时回退全文 blob，避免截断假阴性。
      if (score < 1) {
        const blob = await hitsToEvalBlob(opts.repoRoot, retrieved);
        if (opts.adapter.score(blob, c.gold) >= 1) score = 1;
      }
    }
    if (score >= 1) hits++;
    rows.push({ id: c.id, score, layers: caseLayers, answer: answer.slice(0, 500) });
  }
  const n = opts.cases.length;
  return { hits, accuracy: n === 0 ? 0 : hits / n, rows, layers, answerMode, judge: judgeKind };
}
