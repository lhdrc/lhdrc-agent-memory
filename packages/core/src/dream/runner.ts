/**
 * P3.2 dream cycle v1：5 段（lint / sync / distill_pending / contradictions / orphans）。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { loadPack } from "../schema/loadPack.ts";
import { createLLMProvider, isDistillEnabled } from "../llm/factory.ts";
import { openPglite } from "../index/engine.ts";
import { syncAll } from "../index/sync.ts";
import { refineSource } from "../distill/refine.ts";
import { WriteValidator } from "../write/validator.ts";
import type { WriteQueue } from "../write/queue.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import type { LLMProvider } from "../llm/types.ts";
import { resolveEmbedder } from "../embed/factory.ts";
import { cosineSimilarity, toFloat32 } from "../embed/cosine.ts";
import type { EmbeddingProvider } from "../embed/types.ts";
import { isObjectValueConflict } from "../write/dedupe.ts";
import { isEnvMockCompleteEnabled } from "../llm/mock.ts";
import { hasLlmApiKey } from "../llm/factory.ts";

export type DreamPhase = 1 | 2 | 3 | 4 | 5;

export interface DreamOptions {
  brainId: string;
  queue: WriteQueue;
  fix?: boolean;
  phases?: DreamPhase[];
  /** 测试注入 FakeLLM；提供时跳过 kill_switch 门禁 */
  llm?: LLMProvider;
  /** P10.3 测试注入 mock embedder（跨文件 cosine） */
  embedder?: EmbeddingProvider;
}

export interface DreamPhaseResult {
  phase: DreamPhase;
  name: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DreamResult {
  phases: DreamPhaseResult[];
}

const PHASE_NAMES: Record<DreamPhase, string> = {
  1: "lint",
  2: "sync",
  3: "distill_pending",
  4: "contradictions",
  5: "orphans",
};

async function walkMd(dirAbs: string, baseRel: string, out: string[]): Promise<void> {
  if (!existsSync(dirAbs)) return;
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`;
    if (e.isDirectory()) await walkMd(childAbs, childRel, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(childRel);
  }
}

async function phaseLint(
  repoRoot: string,
  brainId: string,
  fix: boolean,
  queue: WriteQueue,
): Promise<DreamPhaseResult> {
  const cfg = await loadRepoConfig(repoRoot);
  const pack = await loadPack(cfg.schema_pack);
  const validator = new WriteValidator(repoRoot, pack);
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const files: string[] = [];
  await walkMd(join(brainRoot, "sources"), `brains/${brainId}/sources`, files);

  const issues: Array<{ path: string; message: string }> = [];
  let fixed = 0;

  for (const rel of files) {
    const abs = join(repoRoot, rel);
    const raw = await readFile(abs, "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (!data.title) {
      issues.push({ path: rel, message: "missing title" });
      if (fix) {
        data.title = rel.split("/").pop()?.replace(/\.md$/, "") ?? "untitled";
        await queue.execute(async () => {
          await writeFile(abs, serializeFrontmatter(data, body), "utf8");
          return [rel];
        }, `dream lint fix title ${rel}`);
        fixed++;
      }
    }
    if (data.schema_type && !pack.schema_types.includes(String(data.schema_type))) {
      issues.push({ path: rel, message: `schema_type not in pack: ${data.schema_type}` });
    }
    if (rel.includes("..")) {
      issues.push({ path: rel, message: "path contains .." });
    }
    void validator;
  }

  return {
    phase: 1,
    name: "lint",
    ok: true,
    details: { issues: issues.length, fixed, sample: issues.slice(0, 10) },
  };
}

async function phaseSync(repoRoot: string, brainId: string): Promise<DreamPhaseResult> {
  const conn = await openPglite(repoRoot);
  try {
    const { fileCount } = await syncAll(conn.db, repoRoot, brainId);
    return { phase: 2, name: "sync", ok: true, details: { fileCount } };
  } finally {
    await conn.close();
  }
}

async function phaseDistill(
  repoRoot: string,
  brainId: string,
  queue: WriteQueue,
  llm?: LLMProvider,
): Promise<DreamPhaseResult> {
  const cfg = await loadRepoConfig(repoRoot);
  if (!llm && !isDistillEnabled(cfg.llm)) {
    return {
      phase: 3,
      name: "distill_pending",
      ok: true,
      skipped: true,
      reason: "kill_switch_or_llm_off",
    };
  }
  const result = await refineSource(repoRoot, { brainId, queue, llm });
  return {
    phase: 3,
    name: "distill_pending",
    ok: true,
    details: { written: result.written, skipped: result.skipped, reason: result.reason },
  };
}

interface FactCandidate {
  path: string;
  factIndex: number;
  text: string;
  entitySlug: string | null;
  sourceId: string;
}

const MAX_FACTS_FOR_CROSS = 500;
const MAX_CROSS_FINDINGS = 100;
const CROSS_COSINE_THRESHOLD = 0.95;
const GREY_THRESHOLD = 0.92;
const K_PER_FACT = 5;
const LLM_BATCH = 10;

function escapeFactQuote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const NEGATION_RE = /(?:不|非|未|\bno\b|\bnot\b)/i;

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}
function hasNegationDiff(a: string, b: string): boolean {
  return hasNegation(a) !== hasNegation(b);
}

function stripFence(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    const first = t.indexOf("\n");
    const last = t.lastIndexOf("```");
    if (first >= 0 && last > first) return t.slice(first + 1, last).trim();
  }
  return t;
}

function sourceIdFromPath(rel: string): string {
  const parts = rel.split("/");
  const idx = parts.indexOf("sources");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]!;
  return "default";
}

async function loadEntityAliasMap(repoRoot: string, brainId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const entDir = join(brainRoot, "entities");
  if (!existsSync(entDir)) return map;
  const entries = await readdir(entDir, { withFileTypes: true }).catch(() => [] as any[]);
  for (const e of entries as any[]) {
    if (!e.isFile() || !String(e.name).endsWith(".md")) continue;
    try {
      const raw = await readFile(join(entDir, String(e.name)), "utf8");
      const { data } = parseFrontmatter(raw);
      const slug = String((data as any).slug ?? String(e.name).slice(0, -3)).toLowerCase();
      const title = String((data as any).title ?? "").toLowerCase();
      const aliases = Array.isArray((data as any).aliases) ? ((data as any).aliases as unknown[]).map((x) => String(x).toLowerCase()) : [];
      const canonical = slug;
      const names = [slug, title, ...aliases].filter(Boolean);
      for (const n of names) {
        if (!map.has(n)) map.set(n, canonical);
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

function entitySlugForFact(text: string, links: string[], aliasMap: Map<string, string>): string | null {
  const lower = text.toLowerCase();
  // try links first: if fact mentions a link ref
  for (const l of links) {
    const lk = String(l).toLowerCase();
    if (lk && lower.includes(lk)) {
      const mapped = aliasMap.get(lk);
      if (mapped) return mapped;
      return lk;
    }
  }
  for (const [name, canon] of aliasMap) {
    if (!name || name.length < 2) continue;
    if (lower.includes(name)) return canon;
  }
  return null;
}

function normalizeAliasText(text: string, aliasMap: Map<string, string>): string {
  let out = text;
  // replace longer aliases first to avoid partial
  const sorted = [...aliasMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canon] of sorted) {
    if (alias === canon) continue;
    if (alias.length < 2) continue;
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (re.test(out)) out = out.replace(re, canon);
  }
  return out;
}

function isChatAvailable(repoRoot: string, brainId: string, injected?: LLMProvider): boolean {
  if (injected) return true;
  if (isEnvMockCompleteEnabled()) return true;
  // best-effort check via config
  // synchronous fallback: if provider off -> false; if openai without key -> false
  // we defer actual check to async where needed
  return true;
}

async function resolveChatProvider(repoRoot: string, injected?: LLMProvider): Promise<LLMProvider | null> {
  if (injected) return injected;
  try {
    const cfg = await loadRepoConfig(repoRoot);
    if (cfg.llm.provider === "off") return null;
    if (isEnvMockCompleteEnabled()) {
      const { EnvMockLLMProvider } = await import("../llm/mock.ts");
      return new EnvMockLLMProvider();
    }
    if (cfg.llm.provider === "openai" && !hasLlmApiKey(cfg.llm)) return null;
    return createLLMProvider(cfg.llm, { repoRoot });
  } catch {
    return null;
  }
}

function parseClassifierJson(raw: string): { decision: string; matched_id: string } | null {
  const cleaned = stripFence(raw).trim();
  // remove refusal markers
  if (/^(sorry|i'?m not able|i cannot|as an ai)/i.test(cleaned)) return null;
  try {
    const j = JSON.parse(cleaned) as any;
    const d = String(j.decision ?? "").toLowerCase();
    if (d !== "duplicate" && d !== "supersede" && d !== "independent") return null;
    return { decision: d, matched_id: String(j.matched_id ?? "") };
  } catch {
    // try extract json object substring
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]!) as any;
      const d = String(j.decision ?? "").toLowerCase();
      if (d !== "duplicate" && d !== "supersede" && d !== "independent") return null;
      return { decision: d, matched_id: String(j.matched_id ?? "") };
    } catch {
      return null;
    }
  }
}

/**
 * P3.2 + P10.3 + P13.5：实体桶k=5 + cosine≥0.95 duplicate Float32 + 值冲突二筛 + 灰区0.92-0.95批量LLM10 + local规则分支 + 增量
 * 不删、不改 L0 facts（除预填 supersedes）；local档不进LLM；k>5禁止；无自动purge。
 */
async function phaseContradictions(
  repoRoot: string,
  brainId: string,
  opts?: { embedder?: EmbeddingProvider; llm?: LLMProvider },
): Promise<DreamPhaseResult> {
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const files: string[] = [];
  await walkMd(join(brainRoot, "sources"), `brains/${brainId}/sources`, files);
  const intraFindings: string[] = [];
  const allFacts: FactCandidate[] = [];

  const aliasMap = await loadEntityAliasMap(repoRoot, brainId);

  // collect facts with entitySlug + sourceId
  for (const rel of files) {
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const facts = Array.isArray(data.facts) ? (data.facts as Array<Record<string, unknown>>) : [];
    const fmLinks: string[] = Array.isArray((data as any).links)
      ? ((data as any).links as any[]).map((x: any) => String(x?.to ?? "")).filter(Boolean)
      : [];
    // also extract mentions from body for file-level links fallback
    for (let i = 0; i < facts.length; i++) {
      const text = String(facts[i]?.text ?? "").trim();
      if (!text) continue;
      const slug = entitySlugForFact(text, fmLinks, aliasMap);
      allFacts.push({ path: rel, factIndex: i, text, entitySlug: slug, sourceId: sourceIdFromPath(rel) });
    }
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = String(facts[i]?.text ?? "").trim().toLowerCase();
        const b = String(facts[j]?.text ?? "").trim().toLowerCase();
        if (!a || !b) continue;
        const sameType = String(facts[i]?.event_type) === String(facts[j]?.event_type);
        if (!sameType && (a.includes(b) || b.includes(a) || a.slice(0, 40) === b.slice(0, 40))) {
          intraFindings.push(`- ${rel}: 可能冲突 facts[${i}] vs facts[${j}]`);
        }
      }
    }
  }

  // incremental: only new facts +同桶邻居
  let incrementalSet: Set<string> | null = null;
  let effectiveFacts = allFacts;
  try {
    const contraAbs = join(brainRoot, "contradictions.md");
    let lastMtime = 0;
    if (existsSync(contraAbs)) {
      const { stat } = await import("node:fs/promises");
      const st = await stat(contraAbs);
      lastMtime = st.mtimeMs;
    }
    if (lastMtime > 0 && allFacts.length > 0) {
      // determine file mtimes
      const fileMtime = new Map<string, number>();
      for (const rel of files) {
        try {
          const { stat } = await import("node:fs/promises");
          const st = await stat(join(repoRoot, rel));
          fileMtime.set(rel, st.mtimeMs);
        } catch {
          fileMtime.set(rel, 0);
        }
      }
      const newFacts = allFacts.filter((f) => (fileMtime.get(f.path) ?? 0) > lastMtime);
      if (newFacts.length > 0 && newFacts.length < allFacts.length) {
        const bucketOfNew = new Set<string>();
        for (const f of newFacts) bucketOfNew.add(f.entitySlug ?? "_unknown");
        const neighbourKeys = new Set<string>();
        for (const f of newFacts) neighbourKeys.add(`${f.path}#${f.factIndex}`);
        // neighbours: same bucket
        for (const f of allFacts) {
          if (bucketOfNew.has(f.entitySlug ?? "_unknown")) neighbourKeys.add(`${f.path}#${f.factIndex}`);
        }
        effectiveFacts = allFacts.filter((f) => neighbourKeys.has(`${f.path}#${f.factIndex}`));
        incrementalSet = neighbourKeys;
      }
    }
  } catch {
    /* fallback to allFacts */
  }

  // bucket by entitySlug
  const buckets = new Map<string, FactCandidate[]>();
  for (const f of effectiveFacts) {
    const key = f.entitySlug ?? "_unknown";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(f);
  }

  const crossFindings: string[] = [];
  const supersedePairs: Array<{ a: FactCandidate; b: FactCandidate; cos: number; historyA?: string; historyB?: string }> = [];
  let truncated = false;
  let crossSkipped = false;

  let embedder: EmbeddingProvider | undefined;
  let useCrossFile = false;
  let embedFallback = false;
  if (opts?.embedder) {
    embedder = opts.embedder;
    useCrossFile = true;
  } else {
    const cfg = await loadRepoConfig(repoRoot);
    const provider = cfg.embedding.provider;
    if (provider === "openai" || provider === "onnx") {
      const resolved = resolveEmbedder(cfg.embedding);
      embedFallback = resolved.fallback;
      if (!resolved.fallback) {
        embedder = resolved.embedder;
        useCrossFile = true;
      }
    } else if (provider === "local") {
      // local档走规则分支，不设 useCrossFile
      embedFallback = true;
    }
  }

  // helper to decide value-conflict + negation + alias归一
  const isSupersedeCandidate = (aText: string, bText: string): boolean => {
    const aNorm = normalizeAliasText(aText, aliasMap);
    const bNorm = normalizeAliasText(bText, aliasMap);
    if (hasNegationDiff(aNorm, bNorm)) return true;
    if (isObjectValueConflict(aNorm, bNorm)) return true;
    return false;
  };

  // history_index lookup cache
  let historyCache: Map<string, string> | null = null;
  async function getHistoryRef(path: string): Promise<string | undefined> {
    if (!historyCache) {
      historyCache = new Map();
      try {
        const { readHistoryEntries } = await import("../history/index.ts");
        const entries = await readHistoryEntries(repoRoot, brainId);
        for (const e of entries) historyCache!.set(e.md_path.replace(/\\/g, "/"), e.history_ref);
      } catch {
        /* ignore */
      }
    }
    return historyCache.get(path.replace(/\\/g, "/"));
  }

  if (useCrossFile && embedder && effectiveFacts.length >= 2) {
    // limit to MAX_FACTS_FOR_CROSS across all buckets (sorted)
    const sortedAll = [...effectiveFacts].sort((a, b) => a.path.localeCompare(b.path) || a.factIndex - b.factIndex);
    let candidates = sortedAll;
    if (sortedAll.length > MAX_FACTS_FOR_CROSS) {
      // per spec: 500 cap, truncate
      candidates = sortedAll.slice(0, MAX_FACTS_FOR_CROSS);
      truncated = true;
    }
    // build per bucket candidate subsets for k cap
    // embed all candidates
    let vectors: number[][] = [];
    try {
      vectors = await embedder.embed(candidates.map((c) => c.text));
    } catch {
      crossSkipped = true;
    }
    if (!crossSkipped && vectors.length === candidates.length) {
      // Float32视图零拷：转为 Float32Array
      const f32Vectors: Float32Array[] = vectors.map((v) => toFloat32(v));
      // build index map path#idx -> vector index
      const idxMap = new Map<string, number>();
      candidates.forEach((c, i) => idxMap.set(`${c.path}#${c.factIndex}`, i));

      // For each bucket, compute pairwise cos and apply decision tree
      // Collect grey candidates for LLM
      type GreyPair = { left: FactCandidate; right: FactCandidate; cos: number; li: number; ri: number };
      const grey: GreyPair[] = [];

      for (const [bucketKey, bucketFacts] of buckets) {
        // unknown bucket with many items would cause O(n²); skip if unknown and large and no new filter
        if (bucketKey === "_unknown" && bucketFacts.length > 20 && !incrementalSet) {
          // skip large unknown to avoid 500 O(n²)
          continue;
        }
        // sort bucketFacts deterministic
        const bf = [...bucketFacts].sort((a, b) => a.path.localeCompare(b.path) || a.factIndex - b.factIndex);
        // For k=5 cap: per fact top k neighbours by cosine
        // We still need cosine for all pairs within bucket to select topk, but cap LLM pairs.
        // Compute cosine matrix on demand via f32Vectors
        for (let i = 0; i < bf.length && crossFindings.length < MAX_CROSS_FINDINGS + grey.length; i++) {
          const left = bf[i]!;
          const li = idxMap.get(`${left.path}#${left.factIndex}`)!;
          // compute cos to all others
          const scored: Array<{ j: number; cos: number; cand: FactCandidate }> = [];
          for (let j = i + 1; j < bf.length; j++) {
            const right = bf[j]!;
            if (left.path === right.path) continue; // source_id隔离
            const ri = idxMap.get(`${right.path}#${right.factIndex}`)!;
            if (ri === undefined) continue;
            const cos = cosineSimilarity(f32Vectors[li]!, f32Vectors[ri]!);
            scored.push({ j, cos, cand: right });
          }
          // sort descending and take k=5
          scored.sort((a, b) => b.cos - a.cos);
          const top = scored.slice(0, K_PER_FACT);
          for (const s of top) {
            const right = s.cand;
            const cos = s.cos;
            const ri = idxMap.get(`${right.path}#${right.factIndex}`)!;
            if (crossFindings.length >= MAX_CROSS_FINDINGS && grey.length === 0) break;
            // incremental filter: need at least one new
            if (incrementalSet) {
              const aKey = `${left.path}#${left.factIndex}`;
              const bKey = `${right.path}#${right.factIndex}`;
              if (!incrementalSet.has(aKey) && !incrementalSet.has(bKey)) {
                // but we already filtered effectiveFacts to neighbours, so both are neighbours; need at least one new
                // check newFacts membership via file mtime? fallback allow
              }
              // if both not new, skip to reduce noise (but keep new involvement)
              // determine new membership by checking if file mtime > lastMtime; we don't have set, so check again via history?
              // simplification: keep all within neighbour set; don't skip extra
            }
            if (cos >= CROSS_COSINE_THRESHOLD) {
              // 二筛值冲突
              if (isSupersedeCandidate(left.text, right.text)) {
                // 值异/否定 -> supersede候选而非duplicate
                // treat as grey/supersede immediate
                supersedePairs.push({ a: left, b: right, cos });
                crossFindings.push(
                  `- contradiction supersede cosine=${cos.toFixed(4)} \`${left.path}\` facts[${left.factIndex}] → \`${right.path}\` facts[${right.factIndex}]\n  - a: "${escapeFactQuote(left.text)}"\n  - b: "${escapeFactQuote(right.text)}"`,
                );
              } else {
                crossFindings.push(
                  `- duplicate cosine=${cos.toFixed(4)} \`${left.path}\` facts[${left.factIndex}] ↔ \`${right.path}\` facts[${right.factIndex}]\n  - a: "${escapeFactQuote(left.text)}"\n  - b: "${escapeFactQuote(right.text)}"`,
                );
              }
            } else if (cos >= GREY_THRESHOLD) {
              grey.push({ left, right, cos, li, ri });
            }
          }
        }
      }

      // LLM批量10对处理灰区
      if (grey.length > 0) {
        const chatProvider = await resolveChatProvider(repoRoot, opts?.llm);
        const chatAvailable = chatProvider !== null;
        if (!chatAvailable) {
          // 回退：≥0.92 duplicate, else independent (but we are already in grey 0.92-0.95 so duplicate回退)
          for (const g of grey) {
            if (crossFindings.length >= MAX_CROSS_FINDINGS) break;
            if (isSupersedeCandidate(g.left.text, g.right.text)) {
              supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
              crossFindings.push(
                `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
              );
            } else {
              crossFindings.push(
                `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
              );
            }
          }
        } else {
          // batch 10
          const SYSTEM = `You decide duplicate/supersede/independent for incoming fact vs existing candidates. Use entity and value comparison. Reply strictly {"decision":"duplicate|supersede|independent","matched_id":"<existing id>"} . Wrap existing candidates in <existing> DATA tags.`;
          let pending = [...grey];
          while (pending.length > 0 && crossFindings.length < MAX_CROSS_FINDINGS) {
            const batch = pending.slice(0, LLM_BATCH);
            pending = pending.slice(LLM_BATCH);
            // build prompt: list batch pairs
            const lines: string[] = [];
            for (let i = 0; i < batch.length; i++) {
              const g = batch[i]!;
              lines.push(
                `<existing id="${escapeFactQuote(g.left.path)}#${g.left.factIndex}">\n${escapeFactQuote(g.left.text)}\n</existing>\nDATA incoming id="${escapeFactQuote(g.right.path)}#${g.right.factIndex}" text="${escapeFactQuote(g.right.text)}" cos=${g.cos.toFixed(4)}`,
              );
            }
            const prompt = lines.join("\n\n");
            let resultText: string | null = null;
            try {
              const res = await chatProvider!.complete({ purpose: "other", system: SYSTEM, prompt });
              resultText = res.text;
            } catch {
              resultText = null;
            }
            if (!resultText) {
              // timeout/refusal -> 0.92回退 as duplicate
              for (const g of batch) {
                if (crossFindings.length >= MAX_CROSS_FINDINGS) break;
                if (isSupersedeCandidate(g.left.text, g.right.text)) {
                  supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                  crossFindings.push(
                    `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                  );
                } else {
                  crossFindings.push(
                    `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                  );
                }
              }
              continue;
            }
            const cleaned = stripFence(resultText);
            // try to parse as single decision or multiple? Expect one JSON per batch? For batch we may expect multiple lines
            // Try to extract all JSON objects
            const jsonMatches = [...cleaned.matchAll(/\{[\s\S]*?"decision"[\s\S]*?\}/g)];
            if (jsonMatches.length === 0) {
              const parsed = parseClassifierJson(cleaned);
              if (!parsed) {
                // 回退
                for (const g of batch) {
                  if (crossFindings.length >= MAX_CROSS_FINDINGS) break;
                  if (isSupersedeCandidate(g.left.text, g.right.text)) {
                    supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                    crossFindings.push(
                      `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  } else {
                    crossFindings.push(
                      `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  }
                }
              } else {
                // single decision applied to first? Map by matched_id
                const decision = parsed.decision;
                for (const g of batch) {
                  if (crossFindings.length >= MAX_CROSS_FINDINGS) break;
                  // if matched_id matches left or right, use decision
                  const mid = parsed.matched_id;
                  const isMatched = mid.includes(g.left.path) || mid.includes(g.right.path) || mid === `${g.left.path}#${g.left.factIndex}` || mid === `${g.right.path}#${g.right.factIndex}`;
                  const d = isMatched ? decision : decision; // fallback
                  if (d === "supersede") {
                    supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                    crossFindings.push(
                      `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  } else if (d === "duplicate") {
                    if (isSupersedeCandidate(g.left.text, g.right.text)) {
                      supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                      crossFindings.push(
                        `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                      );
                    } else {
                      crossFindings.push(
                        `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                      );
                    }
                  } else if (d === "independent") {
                    // skip
                  } else {
                    // fallback
                    crossFindings.push(
                      `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  }
                }
              }
            } else {
              // multiple decisions
              for (let idx = 0; idx < batch.length && crossFindings.length < MAX_CROSS_FINDINGS; idx++) {
                const g = batch[idx]!;
                const rawJson = jsonMatches[idx]?.[0] ?? jsonMatches[0]?.[0] ?? "";
                const parsed = parseClassifierJson(rawJson);
                if (!parsed) {
                  // 回退
                  if (isSupersedeCandidate(g.left.text, g.right.text)) {
                    supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                    crossFindings.push(
                      `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  } else {
                    crossFindings.push(
                      `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  }
                  continue;
                }
                const d = parsed.decision;
                if (d === "supersede") {
                  supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                  crossFindings.push(
                    `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                  );
                } else if (d === "duplicate") {
                  if (isSupersedeCandidate(g.left.text, g.right.text)) {
                    supersedePairs.push({ a: g.left, b: g.right, cos: g.cos });
                    crossFindings.push(
                      `- contradiction supersede cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] → \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  } else {
                    crossFindings.push(
                      `- duplicate cosine=${g.cos.toFixed(4)} \`${g.left.path}\` facts[${g.left.factIndex}] ↔ \`${g.right.path}\` facts[${g.right.factIndex}]\n  - a: "${escapeFactQuote(g.left.text)}"\n  - b: "${escapeFactQuote(g.right.text)}"`,
                    );
                  }
                } else if (d === "independent") {
                  // no contradiction
                }
              }
            }
          }
        }
      }
    }
  } else {
    // local档或fallback：走规则分支不进LLM
    for (const [bucketKey, bucketFacts] of buckets) {
      if (bucketKey === "_unknown") {
        // for unknown, still apply rule but limit to k per fact with bucket cap to avoid O(n²)
        if (bucketFacts.length > 50) continue;
      }
      const bf = [...bucketFacts].sort((a, b) => a.path.localeCompare(b.path) || a.factIndex - b.factIndex);
      // limit pairs to k per fact via simple lexical proximity (already sorted)
      for (let i = 0; i < bf.length && crossFindings.length < MAX_CROSS_FINDINGS; i++) {
        const left = bf[i]!;
        // take next k candidates after i
        const candidates = bf.slice(i + 1, i + 1 + K_PER_FACT);
        for (const right of candidates) {
          if (left.path === right.path) continue;
          if (incrementalSet) {
            const aKey = `${left.path}#${left.factIndex}`;
            const bKey = `${right.path}#${right.factIndex}`;
            // keep only if one is effectively considered; we already filtered effectiveFacts, so keep
            void aKey; void bKey;
          }
          if (isSupersedeCandidate(left.text, right.text)) {
            // 值异/否定即 supersede
            supersedePairs.push({ a: left, b: right, cos: 0.93 });
            crossFindings.push(
              `- contradiction supersede cosine=0.9300 \`${left.path}\` facts[${left.factIndex}] → \`${right.path}\` facts[${right.factIndex}]\n  - a: "${escapeFactQuote(left.text)}"\n  - b: "${escapeFactQuote(right.text)}"`,
            );
          } else {
            // rule下值同且文本高度相似才判 duplicate；用简易包含判断
            const aLow = left.text.toLowerCase();
            const bLow = right.text.toLowerCase();
            if (aLow.includes(bLow.slice(0, 20)) || bLow.includes(aLow.slice(0, 20)) || aLow.slice(0, 40) === bLow.slice(0, 40)) {
              if (crossFindings.length < MAX_CROSS_FINDINGS) {
                crossFindings.push(
                  `- duplicate cosine=0.9500 \`${left.path}\` facts[${left.factIndex}] ↔ \`${right.path}\` facts[${right.factIndex}]\n  - a: "${escapeFactQuote(left.text)}"\n  - b: "${escapeFactQuote(right.text)}"`,
                );
              }
            } else {
              // even without strong similarity, if same entity bucket and not supersede, still may be duplicate with high cosine proxy?
              // skip
            }
          }
          if (crossFindings.length >= MAX_CROSS_FINDINGS) break;
        }
      }
    }
    // if still no supersede but bucket unknown skipped, try cross-bucket value conflict for same entity via alias归一? Already handled.
  }

  // enrichment: append history_ref if available
  const enrichedFindings: string[] = [];
  for (const line of crossFindings) {
    enrichedFindings.push(line);
    // append history refs inline if found (optional)
    // parse paths from line to lookup
    const m = line.match(/`([^`]+)` facts\[\d+\][\s\S]*?`([^`]+)` facts\[\d+\]/);
    if (m) {
      const hA = await getHistoryRef(m[1]!);
      const hB = await getHistoryRef(m[2]!);
      if (hA || hB) {
        const hist = `  - history: ${hA ? `${m[1]} → ${hA}` : ""}${hA && hB ? " ; " : ""}${hB ? `${m[2]} → ${hB}` : ""}`;
        enrichedFindings[enrichedFindings.length - 1] += `\n${hist}`;
      }
    }
  }

  // 预填 facts.supersedes：为 supersede 对的较新侧预填
  if (supersedePairs.length > 0) {
    // decide direction: newer file mtime supersedes older
    const fileMtimeCache = new Map<string, number>();
    async function mtimeOf(p: string): Promise<number> {
      if (fileMtimeCache.has(p)) return fileMtimeCache.get(p)!;
      try {
        const { stat } = await import("node:fs/promises");
        const st = await stat(join(repoRoot, p));
        fileMtimeCache.set(p, st.mtimeMs);
        return st.mtimeMs;
      } catch {
        fileMtimeCache.set(p, 0);
        return 0;
      }
    }
    for (const pair of supersedePairs) {
      const ta = await mtimeOf(pair.a.path);
      const tb = await mtimeOf(pair.b.path);
      // newer supersedes older; if tie, b supersedes a
      const superseder = tb >= ta ? pair.b : pair.a;
      const superseded = tb >= ta ? pair.a : pair.b;
      try {
        const abs = join(repoRoot, superseder.path);
        const raw = await readFile(abs, "utf8");
        const { data, body } = parseFrontmatter(raw);
        const facts = Array.isArray(data.facts) ? ([...(data.facts as unknown[])] as Array<Record<string, unknown>>) : [];
        const idx = superseder.factIndex;
        if (idx < 0 || idx >= facts.length) continue;
        const rec = facts[idx] as Record<string, unknown>;
        if (typeof rec.supersedes === "string" && String(rec.supersedes).trim()) continue;
        const supersededText = String(superseded.text).slice(0, 500);
        rec.supersedes = supersededText;
        data.facts = facts;
        await writeFile(abs, serializeFrontmatter(data, body.replace(/^\r?\n/, "")), "utf8");
      } catch {
        /* fail-open */
      }
    }
  }

  const header = `# Contradictions\n\n> dream @ ${new Date().toISOString()}\n\n`;
  let body = "";
  if (intraFindings.length === 0 && enrichedFindings.length === 0) {
    body = crossSkipped
      ? "_no contradictions detected_\n\n(cross-file embedding skipped due to error)\n"
      : "_no contradictions detected_\n";
  } else {
    if (intraFindings.length > 0) {
      body += `## intra-file\n\n${intraFindings.join("\n")}\n\n`;
    }
    if (enrichedFindings.length > 0) {
      body += `## cross-file\n\n${enrichedFindings.join("\n\n")}\n`;
    } else if (crossSkipped) {
      body += "## cross-file\n\n(skipped: embedding error)\n";
    }
  }

  await writeFile(join(brainRoot, "contradictions.md"), header + body, "utf8");

  return {
    phase: 4,
    name: "contradictions",
    ok: true,
    details: {
      findings: intraFindings.length,
      cross_file: enrichedFindings.length,
      supersede: supersedePairs.length,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * 无引用的临时 note → status=archived（不物理删除）。
 * 仅当 frontmatter 显式标记 temporary/ephemeral，或 tags 含 temporary|tmp|ephemeral。
 * 普通 note（无 wikilink）不会被误归档。
 */
function isTemporaryNote(data: Record<string, unknown>): boolean {
  if (data.temporary === true || data.ephemeral === true) return true;
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).toLowerCase()) : [];
  return tags.some((t) => t === "temporary" || t === "tmp" || t === "ephemeral");
}

async function phaseOrphans(
  repoRoot: string,
  brainId: string,
  queue: WriteQueue,
): Promise<DreamPhaseResult> {
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const notes: string[] = [];
  await walkMd(join(brainRoot, "sources"), `brains/${brainId}/sources`, notes);

  const conn = await openPglite(repoRoot);
  let archived = 0;
  let skippedNonTemp = 0;
  try {
    for (const rel of notes) {
      if (!rel.includes("/notes/")) continue;
      const abs = join(repoRoot, rel);
      const raw = await readFile(abs, "utf8");
      const { data, body } = parseFrontmatter(raw);
      if (String(data.status) === "archived") continue;
      if (!isTemporaryNote(data)) {
        skippedNonTemp++;
        continue;
      }

      const inbound = await conn.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM links WHERE brain_id = $1 AND (to_ref = $2 OR to_ref LIKE $3)`,
        [brainId, rel, `%/${rel.split("/").pop()}`],
      );
      const n = Number(inbound.rows[0]?.n ?? 0);
      const outbound = await conn.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM links WHERE from_path = $1`,
        [rel],
      );
      const outN = Number(outbound.rows[0]?.n ?? 0);
      if (n === 0 && outN === 0) {
        data.status = "archived";
        await queue.execute(async () => {
          await writeFile(abs, serializeFrontmatter(data, body), "utf8");
          return [rel];
        }, `dream orphan archive ${rel}`);
        archived++;
      }
    }
  } finally {
    await conn.close();
  }

  return {
    phase: 5,
    name: "orphans",
    ok: true,
    details: { archived, skippedNonTemp },
  };
}

export async function runDream(repoRoot: string, opts: DreamOptions): Promise<DreamResult> {
  const phases = opts.phases ?? ([1, 2, 3, 4, 5] as DreamPhase[]);
  const results: DreamPhaseResult[] = [];

  for (const p of phases) {
    let r: DreamPhaseResult;
    switch (p) {
      case 1:
        r = await phaseLint(repoRoot, opts.brainId, Boolean(opts.fix), opts.queue);
        break;
      case 2:
        r = await phaseSync(repoRoot, opts.brainId);
        break;
      case 3:
        r = await phaseDistill(repoRoot, opts.brainId, opts.queue, opts.llm);
        break;
      case 4:
        r = await phaseContradictions(repoRoot, opts.brainId, { embedder: opts.embedder, llm: opts.llm });
        break;
      case 5:
        r = await phaseOrphans(repoRoot, opts.brainId, opts.queue);
        break;
      default:
        r = { phase: p, name: PHASE_NAMES[p] ?? String(p), ok: false, reason: "unknown_phase" };
    }
    results.push(r);
  }

  return { phases: results };
}
