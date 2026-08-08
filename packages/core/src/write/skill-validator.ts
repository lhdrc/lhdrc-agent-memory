/**
 * P3.2 Skill 写入校验（WRITE_FORMAT §10 / D14）。
 */
import { existsSync } from "node:fs";
import { MemoryError } from "../errors.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { normalizeRepoPath } from "../repo/layout.ts";
import type { ValidationError } from "./types.ts";

export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const SKILL_STATUSES = new Set(["candidate", "active", "archived"]);

/** 成熟判定默认常量（P3.2 §3 冻结） */
export const MATURITY_ETA_MIN = 0.7;
export const MATURITY_SUPPORT_MIN = 2;
export const OUTCOME_SUCCESS_DELTA = 0.1;
export const OUTCOME_FAIL_DELTA = -0.2;

export type SkillStatus = "candidate" | "active" | "archived";

export interface SkillWriteInput {
  brainId: string;
  name: string;
  title: string;
  trigger: string;
  procedure: string;
  boundary: string;
  verification: string;
  body?: string;
  status?: SkillStatus;
  etaScore?: number;
  support?: number;
  counterExamples?: string[];
  sourceExperienceIds?: string[];
}

export interface NormalizedSkillWrite {
  brainId: string;
  name: string;
  path: string;
  pathFromBrain: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  status: SkillStatus;
}

export type SkillValidationResult =
  | { ok: true; normalized: NormalizedSkillWrite }
  | {
      ok: false;
      code: "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT";
      errors: ValidationError[];
    };

export function isMatureExperience(fm: {
  eta_score?: unknown;
  support?: unknown;
  counter_examples?: unknown;
}): boolean {
  const eta = Number(fm.eta_score ?? 0);
  const support = Number(fm.support ?? 0);
  const counters = Array.isArray(fm.counter_examples) ? fm.counter_examples : [];
  return eta >= MATURITY_ETA_MIN && support >= MATURITY_SUPPORT_MIN && counters.length === 0;
}

export function clampEta(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function validateSkillWrite(
  repoRoot: string,
  pack: SchemaPack,
  input: SkillWriteInput,
): SkillValidationResult {
  const errors: ValidationError[] = [];
  const name = (input.name ?? "").trim();
  if (!SKILL_NAME_RE.test(name)) {
    errors.push({ field: "name", message: "name 须匹配 [a-z0-9-]{1,64}" });
  }

  if (!pack.schema_types.includes("skill")) {
    errors.push({ field: "schema_type", message: "pack 未声明 skill schema_type" });
  }

  const title = (input.title ?? "").trim();
  if (!title) errors.push({ field: "title", message: "title 必填" });

  const trigger = (input.trigger ?? "").trim();
  if (!trigger) errors.push({ field: "trigger", message: "trigger 必填" });

  const procedure = (input.procedure ?? "").trim();
  if (!procedure) errors.push({ field: "procedure", message: "procedure 必填" });

  const boundary = (input.boundary ?? "").trim();
  if (!boundary) errors.push({ field: "boundary", message: "boundary 必填" });

  const verification = (input.verification ?? "").trim();
  if (!verification) errors.push({ field: "verification", message: "verification 必填" });

  const status = input.status ?? "candidate";
  if (!SKILL_STATUSES.has(status)) {
    errors.push({ field: "status", message: `非法 status: ${status}` });
  }

  if (errors.length > 0) {
    return { ok: false, code: "E_VALIDATION", errors };
  }

  const pathFromBrain = `skills/${name}/SKILL.md`;
  let rel: string;
  try {
    const normalized = normalizeRepoPath(repoRoot, input.brainId, pathFromBrain);
    rel = normalized.rel;
    if (existsSync(normalized.abs)) {
      return {
        ok: false,
        code: "E_CONFLICT",
        errors: [{ field: "path", message: `路径已存在: ${rel}` }],
      };
    }
  } catch (e) {
    if (e instanceof MemoryError) {
      return {
        ok: false,
        code: e.code as "E_VALIDATION" | "E_PATH_ESCAPE" | "E_CONFLICT",
        errors: [{ field: "path", message: e.message }],
      };
    }
    throw e;
  }

  const body =
    input.body?.trim() ||
    `## Procedure\n${procedure}\n\n## Boundary\n${boundary}\n\n## Verification\n${verification}\n`;

  const frontmatter: Record<string, unknown> = {
    name,
    title,
    schema_type: "skill",
    status,
    trigger,
    procedure,
    boundary,
    verification,
    eta_score: input.etaScore ?? 0.5,
    support: input.support ?? 0,
    counter_examples: input.counterExamples ?? [],
    source_experience_ids: input.sourceExperienceIds ?? [],
    created_at: new Date().toISOString(),
  };

  return {
    ok: true,
    normalized: {
      brainId: input.brainId,
      name,
      path: rel,
      pathFromBrain,
      title,
      body,
      frontmatter,
      status,
    },
  };
}
