/**
 * Adapter 全栈流水线开关与指标辅助。
 * 默认：ingest note →（可选基线检索）→ dream 蒸馏+矛盾 → 混合检索（分层标注）。
 */
import type { QueryHit } from "../../packages/core/src/index.ts";
import { hitsToEvalBlob } from "./rule-agent.ts";
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
