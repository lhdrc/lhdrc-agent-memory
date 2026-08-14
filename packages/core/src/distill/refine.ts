import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { loadPack } from "../schema/loadPack.ts";
import { sha256Hex } from "../util/hash.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { writeExperience, patchExperienceStatus, mergeExperienceFields } from "../write/experience.ts";
import { createLLMProvider, isDistillEnabled, type LLMProvider } from "../llm/index.ts";
import { formatExistingExperienceLine, formatJudgeCandidate } from "../llm/distill-prompt.ts";
import { appendMemoryDiff } from "./memory-diff.ts";
import { mapDistillDecision, heuristicAbstract } from "./d17-map.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import { bm25Query } from "../retrieve/query.ts";
import { openPglite } from "../index/engine.ts";
import { maybeAutoCrystallize } from "../crystallize/crystallize.ts";
import type { LLMConfig } from "../llm/types.ts";

export interface RefineSourceOptions {
  brainId: string;
  /** 仓内相对路径或 brain 内路径 */
  path?: string;
  /** 仅处理该 sourceId 下的源（与 --source 对齐） */
  sourceId?: string;
  queue: FileMutationExecutor;
  /** 测试注入 FakeLLM */
  llm?: LLMProvider;
  createdBy?: string;
}

export interface RefineResult {
  skipped: number;
  written: number;
  /** @deprecated 用 skipped_reason；P2.2 仍读 reason */
  reason?: string;
  skipped_reason?: string;
  paths?: string[];
  lazy_omitted?: number;
  crystallized?: string[];
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
): Promise<Array<{ id: string; title: string; trigger: string; snippet: string; path: string; line: string }>> {
  const dir = join(resolveBrainRoot(repoRoot, brainId), "experiences");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const out: Array<{ id: string; title: string; trigger: string; snippet: string; path: string; line: string }> = [];
  for (const f of files) {
    const rel = `brains/${brainId}/experiences/${f}`;
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (data.status !== "active") continue;
    const id = f.replace(/\.md$/, "");
    const title = String(data.title ?? "");
    const trigger = String(data.trigger ?? "");
    const snippet = body.slice(0, 200);
    out.push({
      id,
      title,
      trigger,
      snippet,
      path: rel,
      line: formatExistingExperienceLine({ id, title, trigger, snippet }),
    });
  }
  return out;
}

async function prescreenExperiences(
  repoRoot: string,
  brainId: string,
  query: string,
  existing: Array<{ id: string; path: string; line: string }>,
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
    return existing.filter((e) => hitPaths.has(e.path)).map((e) => e.line);
  } catch {
    return existing.slice(0, 5).map((e) => e.line);
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
  const schemaType = String(data.schema_type ?? "");
  const title = String(data.title ?? "Untitled experience");
  const candidateBody = buildCandidateText(data, body);
  const existing = await listExperienceSummaries(repoRoot, opts.brainId);
  const prescreened = await prescreenExperiences(repoRoot, opts.brainId, candidateBody, existing);
  const candidate = formatJudgeCandidate({
    path: sourceRel.replace(/^brains\/[^/]+\//, ""),
    schemaType,
    title,
    body: candidateBody,
  });

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
    const expAbs = join(repoRoot, expRel);
    let snapshot: { procedure?: string; boundary?: string; body?: string; status?: string } | undefined;
    try {
      const before = parseFrontmatter(await readFile(expAbs, "utf8"));
      snapshot = {
        procedure: String(before.data.procedure ?? ""),
        boundary: String(before.data.boundary ?? ""),
        body: before.body,
        status: String(before.data.status ?? "active"),
      };
    } catch {
      snapshot = undefined;
    }
    const expResult = await llm.refineExperience({
      sourcePath: sourceRel,
      title: String(data.title ?? ""),
      candidate: candidateBody,
      existingSummaries: prescreened,
      task: "merge",
      schemaType,
      targetExpId: mapped.targetExpId,
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
      revert: snapshot
        ? { action: "restore_snapshot", path: expRel, snapshot }
        : undefined,
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

  const expResult = await llm.refineExperience({
    sourcePath: sourceRel,
    title,
    candidate: candidateBody,
    existingSummaries: prescreened,
    task: "create",
    schemaType,
  });

  let abstract: string;
  if (abstractEnabled) {
    try {
      abstract = (await llm.generateAbstract(candidateBody)).trim() || heuristicAbstract(candidateBody);
    } catch {
      abstract = heuristicAbstract(candidateBody);
    }
  } else {
    abstract = heuristicAbstract(candidateBody);
  }

  const expPath = await writeExperience(repoRoot, pack, opts.queue, {
    brainId: opts.brainId,
    title: expResult.title || title,
    trigger: expResult.trigger || title,
    procedure: expResult.procedure || candidateBody.slice(0, 500),
    boundary: expResult.boundary || "See source",
    sourcePaths: [sourceRel.replace(/^brains\/[^/]+\//, "")],
    body: expResult.body || candidateBody,
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

  const sourcesAll = await collectSourcePaths(repoRoot, opts.brainId, opts.path, opts.sourceId);
  let lazyOmitted = 0;
  let sources = sourcesAll;
  if (!opts.path) {
    const distilled = await collectDistilledSourceRels(repoRoot, opts.brainId);
    sources = [];
    for (const src of sourcesAll) {
      if (distilled.has(toBrainSourceRel(opts.brainId, src))) lazyOmitted++;
      else sources.push(src);
    }
  }

  if (!isDistillEnabled(cfg.llm) && !opts.llm) {
    const skipped_reason = distillSkipReason(cfg.llm);
    const crystallized = await maybeAutoCrystallize(repoRoot, { brainId: opts.brainId, queue: opts.queue });
    return {
      skipped: sourcesAll.length,
      written: 0,
      reason: skipped_reason,
      skipped_reason,
      paths: [],
      lazy_omitted: opts.path ? 0 : lazyOmitted,
      crystallized: crystallized?.written,
    };
  }

  if (sources.length === 0) {
    const crystallized = await maybeAutoCrystallize(repoRoot, {
      brainId: opts.brainId,
      queue: opts.queue,
      llm: opts.llm,
    });
    return {
      skipped: 0,
      written: 0,
      reason: "no_sources",
      paths: [],
      lazy_omitted: lazyOmitted,
      crystallized: crystallized?.written,
    };
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

  const crystallized = await maybeAutoCrystallize(repoRoot, {
    brainId: opts.brainId,
    queue: opts.queue,
    llm: opts.llm,
  });

  return {
    skipped,
    written,
    paths,
    lazy_omitted: opts.path ? 0 : lazyOmitted,
    crystallized: crystallized?.written,
  };
}

function distillSkipReason(cfg: LLMConfig): string {
  if (cfg.provider === "off") return "llm_off";
  if (cfg.kill_switch.distill) return "kill_switch";
  return "distill_false";
}

function toBrainSourceRel(brainId: string, input: string): string {
  const p = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const prefix = `brains/${brainId}/`;
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  return p;
}

async function collectDistilledSourceRels(repoRoot: string, brainId: string): Promise<Set<string>> {
  const dir = join(resolveBrainRoot(repoRoot, brainId), "experiences");
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const { data } = parseFrontmatter(raw);
    if (String(data.status) !== "active") continue;
    const paths = Array.isArray(data.source_paths) ? data.source_paths : [];
    for (const sp of paths) {
      out.add(toBrainSourceRel(brainId, String(sp)));
    }
  }
  return out;
}

export async function countUndistilledL0(repoRoot: string, brainId: string): Promise<number> {
  const sources = await collectSourcePaths(repoRoot, brainId);
  const distilled = await collectDistilledSourceRels(repoRoot, brainId);
  let n = 0;
  for (const src of sources) {
    if (!distilled.has(toBrainSourceRel(brainId, src))) n++;
  }
  return n;
}

/** compile 放锁后调用：未蒸 L0 够数才蒸。失败由调用方 warn。 */
export async function maybeLazyDistillAfterCompile(
  repoRoot: string,
  opts: { brainId: string; queue: FileMutationExecutor; llm?: LLMProvider },
): Promise<RefineResult | undefined> {
  const cfg = await loadRepoConfig(repoRoot);
  const min = cfg.distill.lazy_min_sources;
  if (min <= 0) return undefined;
  const n = await countUndistilledL0(repoRoot, opts.brainId);
  if (n < min) return undefined;
  return refineSource(repoRoot, { brainId: opts.brainId, queue: opts.queue, llm: opts.llm });
}

export { normalizeSourcePath, buildCandidateText };
export { mapDistillDecision, heuristicAbstract } from "./d17-map.ts";
