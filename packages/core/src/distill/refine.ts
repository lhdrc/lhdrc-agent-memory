import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { loadPack } from "../schema/loadPack.ts";
import { sha256Hex } from "../util/hash.ts";
import type { WriteQueue } from "../write/queue.ts";
import { writeExperience, patchExperienceStatus, mergeExperienceFields } from "../write/experience.ts";
import { createLLMProvider, isDistillEnabled, type LLMProvider } from "../llm/index.ts";
import { appendMemoryDiff } from "./memory-diff.ts";
import { mapDistillDecision, heuristicAbstract } from "./d17-map.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import { bm25Query } from "../retrieve/query.ts";
import { openPglite } from "../index/engine.ts";

export interface RefineSourceOptions {
  brainId: string;
  /** 仓内相对路径或 brain 内路径 */
  path?: string;
  /** 仅处理该 sourceId 下的源（与 --source 对齐） */
  sourceId?: string;
  queue: WriteQueue;
  /** 测试注入 FakeLLM */
  llm?: LLMProvider;
  createdBy?: string;
}

export interface RefineResult {
  skipped: number;
  written: number;
  reason?: string;
  paths?: string[];
}

function normalizeSourcePath(brainId: string, input: string): string {
  const p = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.startsWith(`brains/${brainId}/`)) return p;
  if (p.startsWith("sources/")) return `brains/${brainId}/${p}`;
  return `brains/${brainId}/sources/default/${p}`;
}

function buildCandidateText(data: Record<string, unknown>, body: string): string {
  const title = String(data.title ?? "");
  const facts = Array.isArray(data.facts)
    ? (data.facts as Array<{ text?: string }>).map((f) => f.text ?? "").join("\n")
    : "";
  const combined = [title, facts, body].filter(Boolean).join("\n");
  return combined.slice(0, 4000);
}

async function listExperienceSummaries(
  repoRoot: string,
  brainId: string,
): Promise<Array<{ id: string; summary: string; path: string }>> {
  const dir = join(resolveBrainRoot(repoRoot, brainId), "experiences");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const out: Array<{ id: string; summary: string; path: string }> = [];
  for (const f of files) {
    const rel = `brains/${brainId}/experiences/${f}`;
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (data.status !== "active") continue;
    const id = f.replace(/\.md$/, "");
    const summary = `${data.title}: ${String(data.trigger ?? "")} ${body.slice(0, 200)}`;
    out.push({ id, summary, path: rel });
  }
  return out;
}

async function prescreenExperiences(
  repoRoot: string,
  brainId: string,
  query: string,
  existing: Array<{ id: string; summary: string; path: string }>,
): Promise<string[]> {
  if (existing.length === 0) return [];
  const conn = await openPglite(repoRoot);
  try {
    const hits = await bm25Query(conn.db, {
      brainId,
      query,
      limit: 5,
      schemaType: "experience",
    });
    const hitPaths = new Set(hits.map((h) => h.path));
    return existing.filter((e) => hitPaths.has(e.path)).map((e) => e.summary);
  } catch {
    return existing.slice(0, 5).map((e) => e.summary);
  } finally {
    await conn.close();
  }
}

async function assertSourceUnchanged(abs: string, hashBefore: string, sourceRel: string): Promise<void> {
  const hashAfter = sha256Hex(await readFile(abs, "utf8"));
  if (hashBefore !== hashAfter) {
    throw new Error(`source bytes mutated: ${sourceRel}`);
  }
}

async function refineOneSource(
  repoRoot: string,
  pack: Awaited<ReturnType<typeof loadPack>>,
  opts: RefineSourceOptions,
  sourceRel: string,
  llm: LLMProvider,
  abstractEnabled: boolean,
): Promise<{ written: boolean; path?: string; skipped?: boolean; reason?: string }> {
  const abs = join(repoRoot, sourceRel);
  if (!sourceRel.includes("/sources/")) {
    return { written: false, skipped: true, reason: "not_source" };
  }

  const sourceHashBefore = sha256Hex(await readFile(abs, "utf8"));
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const candidate = buildCandidateText(data, body);
  const existing = await listExperienceSummaries(repoRoot, opts.brainId);
  const prescreened = await prescreenExperiences(repoRoot, opts.brainId, candidate, existing);

  const decision = await llm.judgeDistill(prescreened, candidate);
  const mapped = mapDistillDecision(decision);

  if (mapped.op === "experience_supersede") {
    const expRel = `brains/${opts.brainId}/experiences/${mapped.targetExpId}.md`;
    await patchExperienceStatus(repoRoot, expRel, opts.queue, "superseded", {
      superseded_by: null,
    });
    await appendMemoryDiff(repoRoot, opts.brainId, {
      op: "experience_supersede",
      paths_written: [expRel],
      paths_readonly_refs: [sourceRel],
      decision: decision as unknown as Record<string, unknown>,
    });
    await assertSourceUnchanged(abs, sourceHashBefore, sourceRel);
    return { written: true, path: expRel };
  }

  if (mapped.op === "experience_merge") {
    const expRel = `brains/${opts.brainId}/experiences/${mapped.targetExpId}.md`;
    const expResult = await llm.refineExperience({
      sourcePath: sourceRel,
      title: String(data.title ?? ""),
      candidate,
      existingSummaries: prescreened,
    });
    await mergeExperienceFields(repoRoot, expRel, opts.queue, {
      procedure: expResult.procedure,
      boundary: expResult.boundary,
      bodyAppend: expResult.body,
    });
    await appendMemoryDiff(repoRoot, opts.brainId, {
      op: "experience_merge",
      paths_written: [expRel],
      paths_readonly_refs: [sourceRel],
      decision: decision as unknown as Record<string, unknown>,
    });
    await assertSourceUnchanged(abs, sourceHashBefore, sourceRel);
    return { written: true, path: expRel };
  }

  if (mapped.op === "noop") {
    await appendMemoryDiff(repoRoot, opts.brainId, {
      op: "noop",
      paths_written: [],
      paths_readonly_refs: [sourceRel],
      decision: decision as unknown as Record<string, unknown>,
    });
    return { written: false, skipped: true, reason: "noop" };
  }

  const title = String(data.title ?? "Untitled experience");
  const expResult = await llm.refineExperience({
    sourcePath: sourceRel,
    title,
    candidate,
    existingSummaries: prescreened,
  });

  let abstract: string;
  if (abstractEnabled) {
    try {
      abstract = (await llm.generateAbstract(candidate)).trim() || heuristicAbstract(candidate);
    } catch {
      abstract = heuristicAbstract(candidate);
    }
  } else {
    abstract = heuristicAbstract(candidate);
  }

  const expPath = await writeExperience(repoRoot, pack, opts.queue, {
    brainId: opts.brainId,
    title: expResult.title || title,
    trigger: expResult.trigger || title,
    procedure: expResult.procedure || candidate.slice(0, 500),
    boundary: expResult.boundary || "See source",
    sourcePaths: [sourceRel.replace(/^brains\/[^/]+\//, "")],
    body: expResult.body || candidate,
    abstract,
  });

  await appendMemoryDiff(repoRoot, opts.brainId, {
    op: "experience_create",
    paths_written: [expPath],
    paths_readonly_refs: [sourceRel],
    decision: decision as unknown as Record<string, unknown>,
    revert: { action: "archive_path", path: expPath },
  });
  await assertSourceUnchanged(abs, sourceHashBefore, sourceRel);
  return { written: true, path: expPath };
}

async function collectSourcePaths(
  repoRoot: string,
  brainId: string,
  path?: string,
  sourceId?: string,
): Promise<string[]> {
  if (path) return [normalizeSourcePath(brainId, path)];
  const sourcesRoot = join(resolveBrainRoot(repoRoot, brainId), "sources");
  if (!existsSync(sourcesRoot)) return [];
  const out: string[] = [];
  if (sourceId) {
    const one = join(sourcesRoot, sourceId);
    if (existsSync(one)) {
      await walkSources(one, `brains/${brainId}/sources/${sourceId}`, out);
    }
    return out;
  }
  await walkSources(sourcesRoot, `brains/${brainId}/sources`, out);
  return out;
}

async function walkSources(dirAbs: string, baseRel: string, out: string[]): Promise<void> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`;
    if (e.isDirectory()) {
      await walkSources(childAbs, childRel, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(childRel);
    }
  }
}

/** 蒸馏入口：只读 sources，写入 experiences/ + memory_diff。 */
export async function refineSource(repoRoot: string, opts: RefineSourceOptions): Promise<RefineResult> {
  const cfg = await loadRepoConfig(repoRoot);
  const pack = await loadPack(cfg.schema_pack);
  const llm = opts.llm ?? createLLMProvider(cfg.llm);
  const abstractEnabled = !cfg.llm.kill_switch.abstract;

  const sources = await collectSourcePaths(repoRoot, opts.brainId, opts.path, opts.sourceId);
  if (sources.length === 0) {
    return { skipped: 0, written: 0, reason: "no_sources" };
  }

  if (!isDistillEnabled(cfg.llm) && !opts.llm) {
    return { skipped: sources.length, written: 0, reason: "llm_off" };
  }

  let written = 0;
  let skipped = 0;
  const paths: string[] = [];

  for (const src of sources) {
    const r = await refineOneSource(repoRoot, pack, opts, src, llm, abstractEnabled);
    if (r.written && r.path) {
      written++;
      paths.push(r.path);
    } else {
      skipped++;
    }
  }

  return { skipped, written, paths };
}

export { normalizeSourcePath, buildCandidateText };
export { mapDistillDecision, heuristicAbstract } from "./d17-map.ts";
