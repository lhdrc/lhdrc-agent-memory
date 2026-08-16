import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "../frontmatter.ts";
import { resolveNodeRelPath } from "../node/paths.ts";
import { makeSnippet, type QueryHit } from "./query.ts";

const ANNOTATE_TYPES = new Set(["experience", "skill"]);

/** P8.2：hybridQuery hit 的层标注（缺则省略，不整次失败）。 */
export type AnnotatedHit = QueryHit;

export function inferSchemaTypeFromPath(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  if (p.includes("/experiences/")) return "experience";
  if (p.includes("/skills/")) return "skill";
  if (/\/sources\/[^/]+\/notes\//.test(p)) return "note";
  if (/\/sources\/[^/]+\/decisions\//.test(p)) return "decision";
  if (/\/sources\/[^/]+\/lessons\//.test(p)) return "lesson";
  return undefined;
}

function parseOptionalNumber(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function extractTrigger(data: Record<string, unknown>, body: string): string {
  const fm = typeof data.trigger === "string" ? data.trigger.trim() : "";
  if (fm) return fm;
  const m = body.match(/^#{1,3}\s*trigger\s*\r?\n+([\s\S]*?)(?:\r?\n#{1,3}\s|\r?\n---|\s*$)/im);
  return m?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function brainIdFromHitPath(path: string): string | undefined {
  const m = path.replace(/\\/g, "/").match(/^brains\/([^/]+)\//);
  return m?.[1];
}

function normalizeSourcePaths(repoRoot: string, hitPath: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const brainId = brainIdFromHitPath(hitPath);
  if (!brainId) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      out.push(resolveNodeRelPath(repoRoot, brainId, item.trim()));
    } catch {
      /* fail-open：跳过无法规范的项 */
    }
  }
  return out.length ? out : undefined;
}

async function annotateOne(
  repoRoot: string,
  hit: QueryHit,
  query: string,
): Promise<QueryHit> {
  const schemaType = inferSchemaTypeFromPath(hit.path);
  const base: QueryHit = schemaType ? { ...hit, schema_type: schemaType } : { ...hit };
  if (!schemaType || !ANNOTATE_TYPES.has(schemaType)) return base;

  try {
    const raw = await readFile(join(repoRoot, hit.path), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const trigger = extractTrigger(data, body);
    const eta = parseOptionalNumber(data.eta_score ?? data.eta);
    const support = parseOptionalNumber(data.support);
    const sourcePaths = normalizeSourcePaths(repoRoot, hit.path, data.source_paths);

    const annotated: QueryHit = { ...base };
    if (trigger) annotated.snippet = makeSnippet(trigger, query || trigger);
    if (eta != null) annotated.eta_score = eta;
    if (support != null) annotated.support = support;
    if (sourcePaths?.length) annotated.source_paths = sourcePaths;
    return annotated;
  } catch {
    return base;
  }
}

/**
 * P82-05/06：对 experience / skill hit 读 frontmatter 补层标注。
 * 读失败 fail-open：保留 path/score，扩展字段省略。
 */
export async function annotateHits(
  repoRoot: string,
  hits: QueryHit[],
  opts?: { query?: string },
): Promise<QueryHit[]> {
  if (!repoRoot || hits.length === 0) return hits;
  const query = opts?.query ?? "";
  const out: QueryHit[] = [];
  for (const hit of hits) {
    out.push(await annotateOne(repoRoot, hit, query));
  }
  return out;
}
