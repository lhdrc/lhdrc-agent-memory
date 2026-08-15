/**
 * P7.1 distill prompt 组装：system 来自 resources；user 由调用方字段拼。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExperienceContext, RefineTask } from "./types.ts";
import { packageRootFrom } from "../util/here.ts";

const RESOURCES = join(packageRootFrom(import.meta.url), "resources");

let judgePromptCache: string | undefined;
let refinePromptCache: string | undefined;
let extractPromptCache: string | undefined;
let abstractPromptCache: string | undefined;
let overviewPromptCache: string | undefined;

export async function loadDistillJudgePrompt(): Promise<string> {
  judgePromptCache ??= await readFile(join(RESOURCES, "distill-judge-v1.md"), "utf8");
  return judgePromptCache;
}

export async function loadDistillRefinePrompt(): Promise<string> {
  refinePromptCache ??= await readFile(join(RESOURCES, "distill-refine-v1.md"), "utf8");
  return refinePromptCache;
}

export async function loadExtractPrompt(): Promise<string> {
  extractPromptCache ??= await readFile(join(RESOURCES, "extract-v1.md"), "utf8");
  return extractPromptCache;
}

export async function loadAbstractPrompt(): Promise<string> {
  abstractPromptCache ??= await readFile(join(RESOURCES, "abstract-v1.md"), "utf8");
  return abstractPromptCache;
}

export async function loadOverviewPrompt(): Promise<string> {
  overviewPromptCache ??= await readFile(join(RESOURCES, "overview-v1.md"), "utf8");
  return overviewPromptCache;
}

export function formatExtractUserPrompt(
  body: string,
  meta: { event_type: string; attributed_to: string; at: string },
): string {
  return [
    `event_type: ${meta.event_type}`,
    `attributed_to: ${meta.attributed_to}`,
    `at: ${meta.at}`,
    "---",
    body,
  ].join("\n");
}

export interface ExistingExperienceLine {
  id: string;
  title: string;
  trigger: string;
  snippet: string;
}

export function formatExistingExperienceLine(e: ExistingExperienceLine): string {
  const snippet = e.snippet.replace(/\s+/g, " ").trim();
  return `- id: ${e.id}\n  title: ${e.title}\n  trigger: ${e.trigger}\n  snippet: ${snippet}`;
}

export function formatJudgeCandidate(opts: {
  path: string;
  schemaType: string;
  title: string;
  body: string;
}): string {
  return [
    "## Candidate source",
    `path: ${opts.path}`,
    `schema_type: ${opts.schemaType || "unknown"}`,
    `title: ${opts.title}`,
    "---",
    opts.body,
  ].join("\n");
}

export function formatJudgeUserPrompt(existing: string[], candidate: string): string {
  const parts = ["## Existing experiences (prescreened; use these ids only)"];
  if (existing.length === 0) {
    parts.push("(none)");
  } else {
    parts.push(...existing);
  }
  parts.push("");
  const cand = candidate.trim();
  if (cand.startsWith("## Candidate source")) {
    parts.push(cand);
  } else {
    parts.push("## Candidate source", cand);
  }
  return parts.join("\n");
}

export const REFINE_TASK_CREATE = "Write a new experience from the candidate.";
export const REFINE_TASK_SYNTHESIZE =
  "Synthesize one reusable skill-shaped experience from the cluster. Generalize; drop instance-only names.";

export function refineTaskLine(task: RefineTask | undefined, targetExpId?: string): string {
  const t = task ?? "create";
  if (t === "merge") {
    const id = targetExpId?.trim() || "unknown";
    return `Merge the candidate into existing experience ${id}. Keep old valid steps; add new ones.`;
  }
  if (t === "synthesize") return REFINE_TASK_SYNTHESIZE;
  return REFINE_TASK_CREATE;
}

export function formatRefineUserPrompt(ctx: ExperienceContext): string {
  const parts = ["## Task", refineTaskLine(ctx.task, ctx.targetExpId), "", "## Candidate"];
  if (ctx.sourcePath) parts.push(`path: ${ctx.sourcePath}`);
  if (ctx.schemaType) parts.push(`schema_type: ${ctx.schemaType}`);
  if (ctx.title) parts.push(`title: ${ctx.title}`);
  parts.push("---", ctx.candidate.trim(), "");
  parts.push("## Existing experiences");
  if (ctx.existingSummaries.length === 0) {
    parts.push("(none)");
  } else {
    parts.push(...ctx.existingSummaries);
  }
  return parts.join("\n");
}

export const JUDGE_JSON_REPAIR_SUFFIX =
  'Previous response was not a JSON object with candidate/item/targetExpId. Return only that JSON object.';

export const REFINE_JSON_REPAIR_SUFFIX =
  'Previous response was not a JSON object with title, trigger, procedure, boundary, and body. Return only that JSON object.';

export const EXTRACT_JSON_REPAIR_SUFFIX =
  'Previous response was not a JSON object with a facts array. Return only { "facts": [ { "text", "event_type", "attributed_to", "at" } ] }.';
