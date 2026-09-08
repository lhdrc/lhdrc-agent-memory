# LoCoMo Re-adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-adapt the outdated LoCoMo adapter to official LoCoMo guidance and fully exercise df-memory's three retrieval arms plus ingest-time dream and on-demand retrieval staging.

**Architecture:** Parse full LoCoMo schema (timestamps, dia_id, observations); ingest each conversation into an isolated `locomo-<sample_id>` brain; run dream phases 3+4 after ingest; retrieve via three-arm `hybridQueryDetailed` (BM25 + semantic + graph) with `thinkQuery` bucket staging (notes → experiences/skills on demand); score with token-F1 + R@k + per-category table.

**Tech Stack:** TypeScript strict + Bun; `bun:test`; PGLite via `openPglite`/`syncAll`; core APIs `captureNode`, `appendSessionTurns`, `hybridQueryDetailed`, `thinkQuery`, `runDream`.

## Global Constraints

- Hermetic default: no network; full data only via `fetch --allow-net` (already cached at `evals/cache/locomo/data.json`).
- `embedding.provider` init default is `openai`; hermetic eval uses `local` hash unless `DF_EVAL_SEMANTIC=1` with a real key.
- `llm.provider` default `off`; no key → `capture` ingest and rule `goldHit` fallback (fail-open, never fake green).
- Brain content only under `brains/{brainId}/`; never mix conversations in one brain.
- L0 hot path stays ADD-only; do not rewrite history to pass eval.
- Full eval is not a CI gate; `--fixture` sample stays the fast path.
- On Spec conflict: update Spec/ADR first, then code.

---

## Background (verified, do not re-derive)

Official LoCoMo (`snap-research/locomo`, ACL 2024): `data/locomo10.json`, 10 conversations; per sample keys `sample_id, conversation, observation, session_summary, event_summary, qa`. Conversation keys: `speaker_a/b`, `session_N` (turns with `speaker/dia_id/text`), `session_N_date_time`. QA fields: `question/answer/evidence/category`. Category map verified against cache (`evals/cache/locomo/data.json`, 1986 Qs): `1=multi-hop(282), 2=temporal(321), 3=open-domain(96), 4=single-hop(841), 5=adversarial(446)`; 1982/1986 have `evidence`. Official RAG findings: three databases `(a) dialogs, (b) observations, (c) session summaries`; observation DB scores best; report F1 + retrieval R@k; adversarial scored separately (expects unanswerable detection).

Current adapter gaps (verified in `evals/adapters/locomo.ts:18-32,34-56`): drops `session_N_date_time`, `dia_id`, `speaker_a/b`, and ignores `observation`/`session_summary`/`event_summary`. `evals/adapter-run.ts:302-326` merges all samples into one `default` brain (cross-conversation contamination; official harness isolates per conversation). Compile path (`adapter-run.ts:227-230`) feeds every turn as `{role:"user", text}` with bare `speaker: text`, losing timestamps. Retrieval (`adapter-run.ts:81-116`) is single-shot hybrid-or-think with embedder off by default (`DF_EVAL_SEMANTIC=0`).

Three arms available in one call (`packages/core/src/retrieve/hybrid.ts:492-617`): BM25 arm + semantic vector arm (`semanticArm`, needs `embedder`) + graph/entity arm (`graphArmDetailed`), fused downstream; `thinkQuery` (`packages/core/src/retrieve/think.ts:31-68`) buckets hits into `skills/experiences/notes`. Dream phases verified (`packages/core/src/dream/runner.ts`): `3=distill_pending`, `4=contradictions` (default `DF_EVAL_DREAM_PHASES=3,4` in `evals/lib/pipeline.ts:23-31`).

---

### Task 1: LoCoMo全量解析（含时间戳/dia_id/observation）

**Files:**
- Modify: `evals/adapters/locomo.ts:1-81`
- Test: `evals/adapters/locomo.test.ts` (new)

**Interfaces:**
- Consumes: raw `locomo10.json` shape (keys above).
- Produces: `LocomoTurn { session, ts, speaker, diaId, text }`, `parseLocomoDetailed(data): { samples: LocomoSampleDetailed[] }`, `LocomoSampleDetailed { sampleId, turns, observations: Array<{session, text}>, cases: EvalCase[] }` (EvalCase keeps existing `id/query/gold/evidence/ingestTexts/meta` from `evals/adapters/types.ts`, plus `meta: { category, sample_id, dia_ids }`).

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseLocomoDetailed } from "./locomo.ts";

test("locomo parse keeps timestamps, dia_id and observations", async () => {
  const raw = JSON.parse(await readFile("evals/cache/locomo/data.json", "utf8"));
  const { samples } = parseLocomoDetailed(raw);
  expect(samples.length).toBe(10);
  const s0 = samples[0]!;
  expect(s0.turns.length).toBeGreaterThan(500);
  expect(s0.turns[0]!.ts.length).toBeGreaterThan(0);
  expect(s0.turns[0]!.diaId.length).toBeGreaterThan(0);
  expect(s0.observations.length).toBeGreaterThan(0);
  expect(s0.cases[0]!.meta!.sample_id).toBe(s0.sampleId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test evals/adapters/locomo.test.ts`
Expected: FAIL with "parseLocomoDetailed is not defined" (or not exported).

- [ ] **Step 3: Write minimal implementation** (replace `turnsFromConversation`/`parseLocomo` in `evals/adapters/locomo.ts`, keep old `parseLocomo`+`load` untouched):

```typescript
export interface LocomoTurn {
  session: string;
  ts: string;
  speaker: string;
  diaId: string;
  text: string;
}

export interface LocomoSampleDetailed {
  sampleId: string;
  turns: LocomoTurn[];
  observations: Array<{ session: string; text: string }>;
  cases: EvalCase[];
}

function turnsFromConversationDetailed(conv: Record<string, unknown> | undefined): LocomoTurn[] {
  if (!conv) return [];
  const out: LocomoTurn[] = [];
  for (const [k, v] of Object.entries(conv)) {
    const m = k.match(/^session_(\d+)$/);
    if (!m || !Array.isArray(v)) continue;
    const ts = String((conv as Record<string, unknown>)[`session_${m[1]}_date_time`] ?? "");
    for (const raw of v) {
      const t = raw as { speaker?: string; dia_id?: string; text?: string };
      const text = String(t.text ?? "").trim();
      if (!text) continue;
      out.push({ session: `session_${m[1]}`, ts, speaker: String(t.speaker ?? "speaker"), diaId: String(t.dia_id ?? ""), text });
    }
  }
  return out;
}

export function parseLocomoDetailed(data: unknown): { samples: LocomoSampleDetailed[] } {
  const raws: LocomoSample[] = Array.isArray(data) ? data : [data as LocomoSample];
  return {
    samples: raws.map((s, si) => {
      const conv = s.conversation as Record<string, unknown> | undefined;
      const turns = turnsFromConversationDetailed(conv);
      const obs = (s as { observation?: Record<string, string> }).observation ?? {};
      const observations = Object.entries(obs)
        .filter(([, v]) => String(v ?? "").trim())
        .map(([k, v]) => ({ session: k, text: String(v) }));
      const cases: EvalCase[] = (s.qa ?? []).flatMap((qa, i) => {
        const query = String(qa.question ?? "").trim();
        return query
          ? [{ id: `${s.sample_id ?? `sample${si}`}-q${i}`, query, gold: qa.answer ?? "", evidence: qa.evidence, ingestTexts: [], meta: { category: qa.category, sample_id: s.sample_id, dia_ids: qa.evidence } }]
          : [];
      });
      return { sampleId: String(s.sample_id ?? `sample${si}`), turns, observations, cases };
    }),
  };
}
```

(Note: `LocomoSample` interface already exists at `locomo.ts:12-16`; extend its `qa` item with `dia` ids already covered by `evidence`. `observation` accessed via cast, no interface change needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test evals/adapters/locomo.test.ts`
Expected: PASS (10 samples; s0 turns = 419 (> 300 floor; range across samples 369–689) with ts/diaId; observations > 0).

- [ ] **Step 5: Commit**

```bash
git add evals/adapters/locomo.ts evals/adapters/locomo.test.ts
git commit -m "eval(locomo): detailed parse with timestamps, dia_id, observations"
```

---

### Task 2: 按conversation隔离摄入（每会话独立brain）

**Files:**
- Modify: `evals/adapter-run.ts:146-155` (workspace brains), `evals/adapter-run.ts:301-326` (capture ingest block)
- Test: manual run `bun run evals/run.ts --adapter locomo --fixture` + new assertion in `evals/adapters/locomo.test.ts`

**Interfaces:**
- Consumes: `LocomoSampleDetailed` from Task 1.
- Produces: `locomoBrainFor(sampleId: string): string` returning `locomo-<sampleId>`; ingest writes only under `brains/locomo-<sampleId>/`.

- [ ] **Step 1: Write the failing test** (append to `evals/adapters/locomo.test.ts`):

```typescript
import { locomoBrainFor } from "../adapter-run.ts";

test("locomo brains are isolated per conversation", () => {
  expect(locomoBrainFor("conv-22")).toBe("locomo-conv-22");
  expect(locomoBrainFor("conv-22")).not.toBe(locomoBrainFor("conv-26"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test evals/adapters/locomo.test.ts`
Expected: FAIL with "locomoBrainFor is not defined".

- [ ] **Step 3: Write minimal implementation**

In `evals/adapter-run.ts`, add above `runAdapter`:

```typescript
export function locomoBrainFor(sampleId: string): string {
  return `locomo-${sampleId}`;
}
```

In the capture ingest block, replace fixed `brainId: "default"` for locomo with per-case brain. Change the loop to read brain from case meta when present (generic, no locomo hard-code in the loop):

```typescript
const brainFor = (c: { meta?: Record<string, unknown> }) =>
  typeof c.meta?.brain === "string" && (c.meta.brain as string).length > 0
    ? (c.meta.brain as string)
    : "default";
```

and in `locomo.ts` `load()`, after `parseLocomoDetailed`, set each case's `meta.brain = locomoBrainFor(sampleId)` and fill `ingestTexts` with formatted lines `[ts] Speaker: text` (compile path in Task 3 reuses the same texts via `appendSessionTurns` with `brainId` from meta). Then in `adapter-run.ts` capture block use `brainFor(c)` for `captureNode`, and `syncAll(conn.db, ws.repoRoot, brainFor(c))` per brain. `createEvalWorkspace` `extraBrains` (see `evals/lib/workspace.ts` usage in `evals/mini.ts:43`) must include all locomo brains.

Turn line format (single function in `locomo.ts`, used by both ingest paths):

```typescript
export function formatLocomoTurn(t: LocomoTurn): string {
  const when = t.ts ? `[${t.ts}] ` : "";
  const dia = t.diaId ? `[${t.diaId}] ` : "";
  return `${when}${dia}${t.speaker}: ${t.text}`;
}
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `bun test evals/adapters/locomo.test.ts` (expect PASS) then `bun run evals/run.ts --adapter locomo --fixture` (expect exit 0, receipt `kind: adapter`, metrics present).
Expected: both green; brains `locomo-fixture-0` under workspace repo.

- [ ] **Step 5: Commit**

```bash
git add evals/adapter-run.ts evals/adapters/locomo.ts evals/adapters/locomo.test.ts
git commit -m "eval(locomo): per-conversation brain isolation"
```

---

### Task 3: Observation第三库 + 会话串行compile摄入

**Files:**
- Modify: `evals/adapters/locomo.ts` (`load()`), `evals/adapter-run.ts:176-300` (compile block brain routing)
- Test: `bun run evals/run.ts --adapter locomo --fixture` with `DF_EVAL_INGEST=capture` and `=compile` (compile needs key or `DF_MEMORY_MOCK_COMPLETE=1`)

**Interfaces:**
- Consumes: `formatLocomoTurn`, observations from Task 1; existing `captureNode(repoRoot, pack, queue, { brainId, sourceId, schemaType, title, body, createdBy })` and `appendSessionTurns({ repoRoot, brainId, sourceId, createdBy, pack, queue, turns, window, sessionId, bindOpen })` (both signatures verified in `adapter-run.ts:219-230,312-319`).
- Produces: observation notes titled `[observation][<session>]` with `schemaType: "note"`; compile turns keep `[ts] Speaker: text` with `role: "user"`.

- [ ] **Step 1: Write the check** (no new unit test; ingest covered by Task 1 parse + this acceptance run):

Run: `DF_EVAL_INGEST=capture bun run evals/run.ts --adapter locomo --fixture`
Expected (before change): exit 0 but no `[observation]` notes in workspace.

- [ ] **Step 2: Implement observation ingest** in `locomo.ts` `load()`: after building cases, append one ingest text per observation:

```typescript
for (const o of sample.observations) {
  ingestTexts.push(`[observation][${o.session}]\n${o.text}`);
}
```

shared by all cases of that sample (same array ref per sample, as today). Capture block stores them as notes with `title = text.slice(0, 80)` (existing behavior) — no title change needed.

- [ ] **Step 3: Route compile block by brain**: in `adapter-run.ts:176-300`, the texts loop currently uses single `brainId: "default"`. Change to carry `{ brain, text }` pairs: build `texts` from cases as `{ brain: brainFor(c), text }`, and pass `brainId: item.brain` to `appendSessionTurns`/`endSession`. Session ids stay per-partition (`evalp${part}...`, existing). Keep `window: true, bindOpen: false` unchanged.

- [ ] **Step 4: Verify both ingest modes**

Run: `DF_EVAL_INGEST=capture bun run evals/run.ts --adapter locomo --fixture` → exit 0.
Run: `DF_MEMORY_MOCK_COMPLETE=1 DF_EVAL_INGEST=compile bun run evals/run.ts --adapter locomo --fixture` → exit 0, log shows `mode=compile`.
Expected: both exit 0 with receipts.

- [ ] **Step 5: Commit**

```bash
git add evals/adapters/locomo.ts evals/adapter-run.ts
git commit -m "eval(locomo): observation third-DB ingest and per-brain compile routing"
```

---

### Task 4: 三臂检索 + 按需分阶段查找

**Files:**
- Create: `evals/lib/locomo-retrieve.ts`
- Modify: `evals/adapter-run.ts:81-116` (`makeRetrieve` call sites for locomo only)
- Test: `evals/lib/locomo-retrieve.test.ts` (new, `bun:test` with mock db? No — test pure staging helper `needsStage2`)

**Interfaces:**
- Consumes: `hybridQueryDetailed(db, {...})` (returns `{ hits, explain? }` with `arms` when `explain: true`; verified `hybrid.ts:464-472,627-638`), `thinkQuery(db, {...})` (returns `{ skills, experiences, notes }`; verified `think.ts:31-68`).
- Produces: `retrieveLocomoStage(db, opts, query): Promise<{ hits: QueryHit[]; stages: string[]; arms: Record<string, number>; historyExpanded: number }>`; `needsStage2(stage1Blob: string, gold: string | string[]): boolean`; `expandWithHistory(repoRoot, brainId, hits, k): Promise<string>`.

Staging design (uses all three arms + all three buckets + history):
- Stage 1: `hybridQueryDetailed` with `embedder` (semantic arm on when `DF_EVAL_SEMANTIC=1`, else BM25+graph arms) AND `thinkQuery` notes bucket; merge by path, record per-arm ranks from `explain.arms`.
- Stage 2 (on demand, only if stage-1 blob misses gold): history回跳 — for top-3 stage-1 hits call `readNode(repoRoot, brainId, hit.path, { withHistory: true })` (verified `packages/core/src/node/read.ts:37-42`, resolves `brains/<id>/history_index.jsonl` → inbox session turns) and append `historyTurns` text (last 4 turns) to the scoring blob. This exercises P13.3 exactly when snippets truncate the answer (temporal/multi-hop).
- Stage 3 (on demand, only if stage-2 blob still misses): add `thinkQuery` experiences + skills buckets. Record `stages` array and `history_expanded: boolean/number` into receipt metrics.

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { needsStage2, expandWithHistory } from "./locomo-retrieve.ts";

test("stage2 triggers only on stage1 miss", () => {
  expect(needsStage2("mochi the corgi", "Mochi")).toBe(false);
  expect(needsStage2("nothing about dogs here", "Mochi")).toBe(true);
});

test("history expansion fail-open on missing node", async () => {
  const out = await expandWithHistory("/nonexistent-root", "default", [
    { path: "brains/default/notes/x.md", title: "x", score: 1, snippet: "s", evidence: [] },
  ]);
  expect(out).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test evals/lib/locomo-retrieve.test.ts`
Expected: FAIL with module/function missing.

- [ ] **Step 3: Write minimal implementation** (`evals/lib/locomo-retrieve.ts`):

```typescript
import { hybridQueryDetailed, type HybridQueryOptions } from "../../packages/core/src/retrieve/hybrid.ts";
import { thinkQuery } from "../../packages/core/src/retrieve/think.ts";
import { readNode } from "../../packages/core/src/index.ts";
import type { QueryHit } from "../../packages/core/src/index.ts";
import type { SqlClient } from "../../packages/core/src/index.ts";
import { goldHit } from "./rule-agent.ts";

export function needsStage2(stage1Blob: string, gold: string | string[]): boolean {
  return !goldHit(stage1Blob, gold);
}

/** history回跳：top-k命中走 readNode(withHistory)，拼后4轮turns；fail-open 返回 ""。 */
export async function expandWithHistory(
  repoRoot: string,
  brainId: string,
  hits: QueryHit[],
  k = 3,
): Promise<string> {
  const parts: string[] = [];
  for (const h of hits.slice(0, k)) {
    try {
      const node = await readNode(repoRoot, brainId, h.path, { withHistory: true });
      const turns = (node as { historyTurns?: Array<{ role: string; text: string }> }).historyTurns ?? [];
      if (turns.length > 0) parts.push(turns.slice(-4).map((t) => `${t.role}: ${t.text}`).join("\n"));
    } catch {
      /* fail-open: capture摄入无history_index时直接跳过 */
    }
  }
  return parts.join("\n");
}

export async function retrieveLocomoStage(
  db: SqlClient,
  opts: { brainId: string; repoRoot: string; embedder?: HybridQueryOptions["embedder"]; limit?: number },
  query: string,
  gold: string | string[],
  blobOf: (hits: QueryHit[]) => string | Promise<string>,
): Promise<{ hits: QueryHit[]; stages: string[]; arms: Record<string, number> }> {
  const limit = opts.limit ?? 10;
  const detailed = await hybridQueryDetailed(db, {
    brainId: opts.brainId, query, limit, repoRoot: opts.repoRoot, embedder: opts.embedder, skipCache: true, explain: true,
  });
  const thought = await thinkQuery(db, { brainId: opts.brainId, query, repoRoot: opts.repoRoot, embedder: opts.embedder, limit });
  const seen = new Map<string, QueryHit>();
  for (const h of [...detailed.hits, ...thought.notes.map((n) => ({ path: n.path, title: n.title, score: n.score, snippet: n.snippet, evidence: [] as string[] } as QueryHit))]) {
    if (!seen.has(h.path)) seen.set(h.path, h);
  }
  const arms: Record<string, number> = {
    bm25: detailed.explain?.arms?.bm25?.length ?? 0,
    semantic: detailed.explain?.arms?.semantic?.length ?? 0,
    graph: detailed.explain?.arms?.graph?.length ?? 0,
  };
  let hits = [...seen.values()].slice(0, limit);
  const stages = ["hybrid3arm+notes"];
  let historyExpanded = 0;
  let blob = await blobOf(hits);
  if (needsStage2(blob, gold)) {
    const extra = await expandWithHistory(opts.repoRoot, opts.brainId, hits, 3);
    if (extra.trim()) {
      historyExpanded = 1;
      stages.push("history");
      blob = `${blob}\n${extra}`;
    }
  }
  if (needsStage2(blob, gold)) {
    for (const extra of [...thought.experiences, ...thought.skills]) {
      const h = { path: extra.path, title: extra.title, score: extra.score, snippet: extra.snippet, evidence: [] as string[] } as QueryHit;
      if (!seen.has(h.path)) { seen.set(h.path, h); hits.push(h); }
    }
    stages.push("experiences+skills");
  }
  return { hits: hits.slice(0, limit), stages, arms, historyExpanded };
}
```

Wire into `adapter-run.ts`: when `adapter.id === "locomo"`, build retrieve with `retrieveLocomoStage` bound to per-case brain (`brainFor(c)`), passing `hitsToEvalBlob` as `blobOf` and `queryEmbedder` as embedder. Aggregate per-case `stages`/`historyExpanded` into receipt (`stage_histogram`, `history_expand_rate`). Other adapters keep `makeRetrieve` unchanged.

- [ ] **Step 4: Run tests**

Run: `bun test evals/lib/locomo-retrieve.test.ts` → PASS.
Run: `bun run evals/run.ts --adapter locomo --fixture` → exit 0.
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add evals/lib/locomo-retrieve.ts evals/lib/locomo-retrieve.test.ts evals/adapter-run.ts
git commit -m "eval(locomo): three-arm retrieval with on-demand experience/skill staging"
```

---

### Task 5: 官方口径评分（F1 + R@k + 分类表，adversarial单列）

**Files:**
- Create: `evals/lib/locomo-score.ts`
- Test: `evals/lib/locomo-score.test.ts` (new)
- Modify: `evals/adapter-run.ts:442-494` (locomo metrics block)

**Interfaces:**
- Consumes: per-case `{ score, answerOrBlob, retrievedDiaIds, category }`.
- Produces: `tokenF1(pred, gold): number`, `recallAtK(retrievedDiaIds: string[], evidence: string[], k: number): number`, `LOC_QUERY_KIND` category names `{ 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" }`, `scoreLocomo(...)` returning `{ f1, accuracy, rAtK, byCategory: Record<string, { n, accuracy, f1 }> }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { tokenF1, recallAtK } from "./locomo-score.ts";

test("tokenF1 partial overlap", () => {
  expect(tokenF1("7 May 2023", "7 May 2023")).toBe(1);
  expect(tokenF1("May 2023", "7 May 2023")).toBeLessThan(1);
  expect(tokenF1("May 2023", "7 May 2023")).toBeGreaterThan(0);
});

test("recallAtK hits evidence dia", () => {
  expect(recallAtK(["D1:3", "D9:1"], ["D1:3"], 5)).toBe(1);
  expect(recallAtK(["D9:1"], ["D1:3"], 5)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test evals/lib/locomo-score.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Write minimal implementation** (`evals/lib/locomo-score.ts`):

```typescript
const LOCOMO_CATEGORIES: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

export function locomoCategoryName(c: unknown): string {
  return LOCOMO_CATEGORIES[Number(c)] ?? `cat${String(c)}`;
}

function norm(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, " ").split(/\s+/).filter(Boolean);
}

export function tokenF1(pred: string, gold: string | string[]): number {
  const golds = (Array.isArray(gold) ? gold : [gold]).map(String).filter((g) => g.trim());
  if (!golds.length) return 0;
  const pt = norm(pred);
  let best = 0;
  for (const g of golds) {
    const gt = norm(g);
    if (!pt.length || !gt.length) continue;
    const counts = new Map<string, number>();
    for (const t of pt) counts.set(t, (counts.get(t) ?? 0) + 1);
    let overlap = 0;
    for (const t of gt) {
      const c = counts.get(t) ?? 0;
      if (c > 0) { overlap++; counts.set(t, c - 1); }
    }
    const p = overlap / pt.length;
    const r = overlap / gt.length;
    const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
    best = Math.max(best, f1);
  }
  return best;
}

export function recallAtK(retrievedDiaIds: string[], evidence: string[], k: number): number {
  const ev = evidence.map(String).filter(Boolean);
  if (!ev.length) return 0;
  const top = new Set(retrievedDiaIds.slice(0, k).map(String));
  const hit = ev.filter((e) => top.has(e)).length;
  return hit / ev.length;
}
```

`scoreLocomo` aggregates per case: accuracy via existing `adapter.score` (keeps receipt `accuracy` comparable), plus mean `tokenF1`, mean `recallAtK` (k=5, dia ids extracted from hit titles/snippets matching `/D\d+:\d+/`), grouped by `locomoCategoryName`; category 5 reported under `byCategory.adversarial` and excluded from `accuracy_main` (new field, old `accuracy` untouched).

Wire into `adapter-run.ts` locomo metrics: add `f1`, `r_at_5`, `by_category`, `accuracy_main` alongside existing `accuracy/retrieval/layers/distill/contradictions`.

- [ ] **Step 4: Run tests**

Run: `bun test evals/lib/locomo-score.test.ts` → PASS.
Run: `bun run evals/run.ts --adapter locomo --fixture` → exit 0, receipt contains `f1`, `by_category`.
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add evals/lib/locomo-score.ts evals/lib/locomo-score.test.ts evals/adapter-run.ts
git commit -m "eval(locomo): official-style F1, R@k and per-category scoring"
```

---

### Task 6: fixture刷新 + 文档 + 真全量冒烟

**Files:**
- Modify: `evals/fixtures/locomo-sample/sample.json`, `evals/GROUPMEM_ORGMEM.md` (append LoCoMo section) or create `evals/LOCOMO.md`
- Test: fixture run + `DF_EVAL_MAX_INGEST=200` real-cache smoke (no commit of cache)

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: fixture sample with `dia_id`, `session_N_date_time`, `observation`, mixed categories; doc with commands + metric glossary.

- [ ] **Step 1: Extend fixture** `sample.json`: add `dia_id` to each turn, `session_1_date_time` (exists), one `observation: { session_1_observation: "..." }` entry, and 2 more QA (one temporal cat2, one adversarial cat5 with answer like "unanswerable / not mentioned").

- [ ] **Step 2: Run fixture**

Run: `bun run evals/run.ts --adapter locomo --fixture`
Expected: exit 0; receipt `by_category` has keys; `distill`/`contradictions` present when `DF_EVAL_FULL=1`.

- [ ] **Step 3: Real-cache smoke (bounded)**

Run: `DF_EVAL_FULL=0 DF_EVAL_MAX_INGEST=200 bun run evals/run.ts --adapter locomo`
Expected: exit code reflects accuracy (< 1 → exit 1 is normal, receipt still written); check `evals/receipts/latest.json` for `f1`/`r_at_5`. Full unbounded run explicitly out of scope for this plan (slow ingest, not CI).

- [ ] **Step 4: Write doc** `evals/LOCOMO.md`: data pin (`snap-research/locomo locomo10.json`), category map, ingest design (per-conversation brains + observation third DB + dream 3,4), retrieval design (3 arms + staging), metric glossary (`accuracy`, `accuracy_main`, `f1`, `r_at_5`, `by_category`, `stages`, `arms`), commands for fixture/smoke/full, and known limitation (cat5 abstention needs LLM judge via `DF_EVAL_JUDGE=llm`).

- [ ] **Step 5: Commit**

```bash
git add evals/fixtures/locomo-sample/sample.json evals/LOCOMO.md
git commit -m "eval(locomo): fixture with dia_id/observation/adversarial and LOCOMO.md"
```

---

## Self-Review

- Spec coverage: official QA-5-categories → Task 5 (F1/R@k/category table, adversarial split); 3 RAG databases → Task 3 (dialogs + observations; session summaries intentionally mapped to existing abstract/overview layers, no new schema); per-conversation isolation → Task 2; three retrieval arms → Task 4 (hybridQueryDetailed arms + think buckets); ingest dream → existing `DF_EVAL_FULL=1` + Task 3 compile routing; on-demand lookup → Task 4 staging. Event-summarization and multimodal-dialog tasks out of scope (no memory-system surface for them; noted in LOCOMO.md).
- Placeholder scan: all steps carry exact paths, code, commands, expected outputs; no TBD/TODO/similar-to.
- Type consistency: `LocomoTurn`/`LocomoSampleDetailed`/`formatLocomoTurn`/`locomoBrainFor`/`retrieveLocomoStage`/`needsStage2`/`tokenF1`/`recallAtK`/`locomoCategoryName` defined once, reused verbatim across tasks.
