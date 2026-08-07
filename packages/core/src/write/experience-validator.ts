import { existsSync } from "node:fs";
import { MemoryError } from "../errors.ts";
import type { SchemaPack } from "../schema/loadPack.ts";
import { normalizeRepoPath } from "../repo/layout.ts";
import type { ValidationError, NormalizedExperienceWrite, ExperienceValidationResult } from "./types.ts";
import { buildMarkdownBody } from "./capture.ts";

const EXP_STATUSES = new Set(["active", "superseded", "archived"]);
const MAX_BODY_CHARS = 200_000;

export interface ExperienceWriteInput {
  brainId: string;
  title: string;
  trigger: string;
  procedure: string;
  boundary: string;
  sourcePaths: string[];
  body?: string;
  status?: "active" | "superseded" | "archived";
  version?: number;
  supersedes?: string[];
  supersededBy?: string | null;
  etaScore?: number;
  support?: number;
  counterExamples?: string[];
  abstract?: string;
  /** 缺省则自动生成 ulid-like id */
  id?: string;
}

export function generateExperienceId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function validateExperienceWrite(
  repoRoot: string,
  pack: SchemaPack,
  input: ExperienceWriteInput,
): ExperienceValidationResult {
  const errors: ValidationError[] = [];
  const title = (input.title ?? "").trim();
  if (!title) errors.push({ field: "title", message: "title 必填" });
  else if (title.length > 200) errors.push({ field: "title", message: "title 超过 200 字符" });

  if (!pack.schema_types.includes("experience")) {
    errors.push({ field: "schema_type", message: "pack 未声明 experience schema_type" });
  }

  const trigger = (input.trigger ?? "").trim();
  if (!trigger) errors.push({ field: "trigger", message: "trigger 必填" });

  const procedure = (input.procedure ?? "").trim();
  if (!procedure) errors.push({ field: "procedure", message: "procedure 必填" });

  const boundary = (input.boundary ?? "").trim();
  if (!boundary) errors.push({ field: "boundary", message: "boundary 必填" });

  if (!Array.isArray(input.sourcePaths) || input.sourcePaths.length === 0) {
    errors.push({ field: "source_paths", message: "source_paths 非空数组" });
  } else {
    for (const sp of input.sourcePaths) {
      if (!sp.trim()) errors.push({ field: "source_paths", message: "source_paths 项非空" });
    }
  }

  const status = input.status ?? "active";
  if (!EXP_STATUSES.has(status)) {
    errors.push({ field: "status", message: `非法 status: ${status}` });
  }

  const body = input.body ?? "";
  if (body.length > MAX_BODY_CHARS) {
    errors.push({ field: "body", message: `body 超过 ${MAX_BODY_CHARS} 字符` });
  }

  if (errors.length > 0) {
    return { ok: false, code: "E_VALIDATION", errors };
  }

  const id = input.id ?? generateExperienceId();
  const pathFromBrain = `experiences/${id}.md`;
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

  const createdAt = new Date().toISOString();
  const frontmatter: Record<string, unknown> = {
    title,
    schema_type: "experience",
    status,
    trigger,
    procedure,
    boundary,
    source_paths: input.sourcePaths,
    version: input.version ?? 1,
    created_at: createdAt,
    supersedes: input.supersedes ?? [],
    superseded_by: input.supersededBy ?? null,
    eta_score: input.etaScore ?? 0.5,
    support: input.support ?? 0,
    counter_examples: input.counterExamples ?? [],
  };
  if (input.abstract != null && input.abstract !== "") {
    frontmatter.abstract = input.abstract;
  }

  const mdBody = buildMarkdownBody(body || `${procedure}\n\n${boundary}`);

  const normalized: NormalizedExperienceWrite = {
    brainId: input.brainId,
    id,
    path: rel,
    pathFromBrain,
    title,
    body: mdBody,
    frontmatter,
    createdAt,
    status,
  };

  return { ok: true, normalized };
}
