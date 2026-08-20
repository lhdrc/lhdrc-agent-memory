/**
 * P3.2 dream cycle v1：5 段（lint / sync / distill_pending / contradictions / orphans）。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { loadPack } from "../schema/loadPack.ts";
import { isDistillEnabled } from "../llm/factory.ts";
import { openPglite } from "../index/engine.ts";
import { syncAll } from "../index/sync.ts";
import { refineSource } from "../distill/refine.ts";
import { WriteValidator } from "../write/validator.ts";
import type { WriteQueue } from "../write/queue.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import type { LLMProvider } from "../llm/types.ts";
import { resolveEmbedder } from "../embed/factory.ts";
import { cosineSimilarity } from "../embed/cosine.ts";
import type { EmbeddingProvider } from "../embed/types.ts";

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
}

const MAX_FACTS_FOR_CROSS = 500;
const MAX_CROSS_FINDINGS = 100;
const CROSS_COSINE_THRESHOLD = 0.95;

function escapeFactQuote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * P3.2 + P10.3：同文件启发式 + 跨文件 cosine 近似 facts。
 * 不删、不改 L0 facts；embedding local/off 或 fallback 时跳过跨文件。
 */
async function phaseContradictions(
  repoRoot: string,
  brainId: string,
  opts?: { embedder?: EmbeddingProvider },
): Promise<DreamPhaseResult> {
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const files: string[] = [];
  await walkMd(join(brainRoot, "sources"), `brains/${brainId}/sources`, files);
  const intraFindings: string[] = [];
  const allFacts: FactCandidate[] = [];

  for (const rel of files) {
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data } = parseFrontmatter(raw);
    const facts = Array.isArray(data.facts) ? (data.facts as Array<Record<string, unknown>>) : [];
    for (let i = 0; i < facts.length; i++) {
      const text = String(facts[i]?.text ?? "").trim();
      if (text) allFacts.push({ path: rel, factIndex: i, text });
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

  const crossFindings: string[] = [];
  let truncated = false;
  let crossSkipped = false;

  let embedder: EmbeddingProvider | undefined;
  let useCrossFile = false;
  if (opts?.embedder) {
    embedder = opts.embedder;
    useCrossFile = true;
  } else {
    const cfg = await loadRepoConfig(repoRoot);
    const provider = cfg.embedding.provider;
    if (provider === "openai" || provider === "onnx") {
      const resolved = resolveEmbedder(cfg.embedding);
      if (!resolved.fallback) {
        embedder = resolved.embedder;
        useCrossFile = true;
      }
    }
  }

  if (useCrossFile && embedder && allFacts.length >= 2) {
    const sorted = [...allFacts].sort(
      (a, b) => a.path.localeCompare(b.path) || a.factIndex - b.factIndex,
    );
    const candidates =
      sorted.length > MAX_FACTS_FOR_CROSS ? sorted.slice(0, MAX_FACTS_FOR_CROSS) : sorted;
    if (sorted.length > MAX_FACTS_FOR_CROSS) truncated = true;

    try {
      const vectors = await embedder.embed(candidates.map((c) => c.text));
      for (let i = 0; i < candidates.length && crossFindings.length < MAX_CROSS_FINDINGS; i++) {
        for (let j = i + 1; j < candidates.length && crossFindings.length < MAX_CROSS_FINDINGS; j++) {
          const left = candidates[i]!;
          const right = candidates[j]!;
          if (left.path === right.path) continue;
          const cos = cosineSimilarity(vectors[i]!, vectors[j]!);
          if (cos >= CROSS_COSINE_THRESHOLD) {
            crossFindings.push(
              `- duplicate cosine=${cos.toFixed(4)} \`${left.path}\` facts[${left.factIndex}] ↔ \`${right.path}\` facts[${right.factIndex}]\n  - a: "${escapeFactQuote(left.text)}"\n  - b: "${escapeFactQuote(right.text)}"`,
            );
          }
        }
      }
    } catch {
      crossSkipped = true;
    }
  }

  const header = `# Contradictions\n\n> dream @ ${new Date().toISOString()}\n\n`;
  let body = "";
  if (intraFindings.length === 0 && crossFindings.length === 0) {
    body = crossSkipped
      ? "_no contradictions detected_\n\n(cross-file embedding skipped due to error)\n"
      : "_no contradictions detected_\n";
  } else {
    if (intraFindings.length > 0) {
      body += `## intra-file\n\n${intraFindings.join("\n")}\n\n`;
    }
    if (crossFindings.length > 0) {
      body += `## cross-file\n\n${crossFindings.join("\n\n")}\n`;
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
      cross_file: crossFindings.length,
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
        r = await phaseContradictions(repoRoot, opts.brainId, { embedder: opts.embedder });
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
