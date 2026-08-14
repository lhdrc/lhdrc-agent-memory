/**
 * P3.2：成熟经验 → SKILL.md（candidate）。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { loadPack } from "../schema/loadPack.ts";
import { loadRepoConfig } from "../repo/config.ts";
import { createLLMProvider, isDistillEnabled } from "../llm/factory.ts";
import type { LLMProvider } from "../llm/types.ts";
import { appendMemoryDiff } from "../distill/memory-diff.ts";
import { readCostConfig, withCostAccounting } from "../cost/logger.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { writeSkill, isMatureExperience } from "../write/skill.ts";
import { titleToSlug } from "../util/slug.ts";
import { sha256Hex } from "../util/hash.ts";
import { readFile } from "node:fs/promises";

export interface CrystallizeOptions {
  brainId: string;
  queue: FileMutationExecutor;
  /** 只结晶该 trigger（精确或包含） */
  trigger?: string;
  /** 指定经验相对路径或 id */
  experience?: string;
  /** 技能名；缺省由 trigger slug 化 */
  name?: string;
  llm?: LLMProvider;
}

export interface CrystallizeResult {
  written: string[];
  skipped: number;
  reason?: string;
  errors?: Array<{ cluster: string; code: string; message: string }>;
}

interface ExpRow {
  id: string;
  path: string;
  title: string;
  trigger: string;
  procedure: string;
  boundary: string;
  body: string;
  eta_score: number;
  support: number;
  counter_examples: string[];
}

async function loadExperiences(repoRoot: string, brainId: string): Promise<ExpRow[]> {
  const dir = join(repoRoot, "brains", brainId, "experiences");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const out: ExpRow[] = [];
  for (const f of files) {
    const rel = `brains/${brainId}/experiences/${f}`;
    const raw = await readFile(join(repoRoot, rel), "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (String(data.status) === "archived" || String(data.status) === "superseded") continue;
    out.push({
      id: f.replace(/\.md$/, ""),
      path: rel,
      title: String(data.title ?? f),
      trigger: String(data.trigger ?? ""),
      procedure: String(data.procedure ?? ""),
      boundary: String(data.boundary ?? ""),
      body,
      eta_score: Number(data.eta_score ?? 0.5),
      support: Number(data.support ?? 0),
      counter_examples: Array.isArray(data.counter_examples)
        ? (data.counter_examples as string[])
        : [],
    });
  }
  return out;
}

function heuristicSkillFromCluster(exps: ExpRow[]): {
  title: string;
  trigger: string;
  procedure: string;
  boundary: string;
  verification: string;
  body: string;
} {
  const trigger = exps[0]!.trigger;
  const title = exps[0]!.title;
  const procedure = exps.map((e, i) => `${i + 1}. (${e.id}) ${e.procedure}`).join("\n");
  const boundary = [...new Set(exps.map((e) => e.boundary).filter(Boolean))].join("\n");
  const verification = `复现 trigger「${trigger}」相关回归用例；确认 support≥2 且无反例。`;
  const body = `## Procedure\n${procedure}\n\n## Boundary\n${boundary || "见来源经验"}\n\n## Verification\n${verification}\n`;
  return { title, trigger, procedure, boundary: boundary || "见来源经验", verification, body };
}

function skillNameFromTrigger(trigger: string, explicit?: string): string {
  if (explicit) return explicit;
  const ascii = titleToSlug(trigger)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return ascii || `skill-${sha256Hex(trigger).slice(0, 16)}`;
}

/** 结晶成熟经验簇为 candidate SKILL.md。 */
export async function crystallizeExperiences(
  repoRoot: string,
  opts: CrystallizeOptions,
): Promise<CrystallizeResult> {
  const cfg = await loadRepoConfig(repoRoot);
  const pack = await loadPack(cfg.schema_pack);
  const costCfg = readCostConfig(cfg);
  let llm = opts.llm ?? createLLMProvider(cfg.llm);
  llm = withCostAccounting(llm, repoRoot, costCfg, "crystallize");

  const all = await loadExperiences(repoRoot, opts.brainId);
  let candidates = all.filter((e) =>
    isMatureExperience({
      eta_score: e.eta_score,
      support: e.support,
      counter_examples: e.counter_examples,
    }),
  );

  if (opts.experience) {
    const key = opts.experience.replace(/\.md$/, "");
    candidates = candidates.filter(
      (e) => e.id === key || e.path.endsWith(`/${key}.md`) || e.path === opts.experience,
    );
  }
  if (opts.trigger) {
    const t = opts.trigger.toLowerCase();
    candidates = candidates.filter((e) => e.trigger.toLowerCase().includes(t));
  }

  if (candidates.length === 0) {
    return { written: [], skipped: all.length, reason: "no_mature_experience" };
  }

  // 按 trigger 聚类
  const clusters = new Map<string, ExpRow[]>();
  for (const e of candidates) {
    const k = e.trigger.trim().toLowerCase() || e.id;
    const arr = clusters.get(k) ?? [];
    arr.push(e);
    clusters.set(k, arr);
  }

  const written: string[] = [];
  let skipped = 0;
  const errors: Array<{ cluster: string; code: string; message: string }> = [];
  const useModel = Boolean(opts.llm) || (cfg.llm.provider !== "off" && isDistillEnabled(cfg.llm));

  for (const [, cluster] of clusters) {
    const name = skillNameFromTrigger(cluster[0]!.trigger, opts.name);
    const rel = `brains/${opts.brainId}/skills/${name}/SKILL.md`;
    if (existsSync(join(repoRoot, rel))) {
      skipped += cluster.length;
      continue;
    }

    let synthesized = heuristicSkillFromCluster(cluster);
    if (useModel) {
      try {
        const joined = cluster.map((e) => `${e.title}\n${e.procedure}\n${e.boundary}`).join("\n---\n");
        const expResult = await llm.refineExperience({
          sourcePath: cluster.map((e) => e.path).join(","),
          title: cluster[0]!.title,
          candidate: joined,
          existingSummaries: cluster.map((e) => e.trigger),
          task: "synthesize",
        });
        synthesized = {
          title: expResult.title || synthesized.title,
          trigger: expResult.trigger || synthesized.trigger,
          procedure: expResult.procedure || synthesized.procedure,
          boundary: expResult.boundary || synthesized.boundary,
          verification: synthesized.verification,
          body:
            expResult.body ||
            `## Procedure\n${expResult.procedure}\n\n## Boundary\n${expResult.boundary}\n\n## Verification\n${synthesized.verification}\n`,
        };
      } catch (e) {
        const err = e instanceof MemoryError ? e : new MemoryError(ErrorCodes.LLM, e instanceof Error ? e.message : String(e));
        errors.push({ cluster: name, code: err.code, message: err.message });
        skipped += cluster.length;
        continue;
      }
    }

    const avgEta =
      cluster.reduce((s, e) => s + e.eta_score, 0) / Math.max(1, cluster.length);
    const maxSupport = Math.max(...cluster.map((e) => e.support));

    const path = await writeSkill(repoRoot, pack, opts.queue, {
      brainId: opts.brainId,
      name,
      title: synthesized.title,
      trigger: synthesized.trigger,
      procedure: synthesized.procedure,
      boundary: synthesized.boundary,
      verification: synthesized.verification,
      body: synthesized.body,
      status: "candidate",
      etaScore: avgEta,
      support: maxSupport,
      sourceExperienceIds: cluster.map((e) => e.id),
    });

    await appendMemoryDiff(repoRoot, opts.brainId, {
      op: "skill_create",
      paths_written: [path],
      paths_readonly_refs: cluster.map((e) => e.path),
      decision: {
        trigger: synthesized.trigger,
        experience_ids: cluster.map((e) => e.id),
        status: "candidate",
      },
    });

    written.push(path);
    // 若指定了 name，只写一个簇
    if (opts.name) break;
  }

  if (written.length === 0 && skipped > 0) {
    return { written, skipped, reason: errors.length ? "llm_error" : "skill_exists", errors: errors.length ? errors : undefined };
  }
  return { written, skipped, errors: errors.length ? errors : undefined };
}

/** refine 后自动结晶 candidate；provider=off 或 auto_crystallize=false 则跳过。 */
export async function maybeAutoCrystallize(
  repoRoot: string,
  opts: Pick<CrystallizeOptions, "brainId" | "queue" | "llm">,
): Promise<CrystallizeResult | undefined> {
  const cfg = await loadRepoConfig(repoRoot);
  if (!cfg.distill.auto_crystallize) return undefined;
  if (cfg.llm.provider === "off") return undefined;
  return crystallizeExperiences(repoRoot, opts);
}

export async function requireMatureOrThrow(fm: Record<string, unknown>): Promise<void> {
  if (!isMatureExperience(fm)) {
    throw new MemoryError(
      ErrorCodes.USAGE,
      `经验未成熟：需要 eta_score>=0.7、support>=2 且 counter_examples 为空`,
    );
  }
}
