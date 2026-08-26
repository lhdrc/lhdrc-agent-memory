import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import type { FileMutationExecutor } from "../write/executor.ts";
import { parseCrossFileFindings, pairIdOf, type CrossFileFinding } from "./parse.ts";

export type ContradictionKeep = "a" | "b" | "both";

export interface ContradictionReview {
  pair_id: string;
  keep: ContradictionKeep;
  at: string;
  by: string;
}

export interface ContradictionListItem extends CrossFileFinding {
  pair_id: string;
  status: "pending" | ContradictionKeep;
}

function reviewsRel(brainId: string): string {
  return `brains/${brainId}/contradictions-reviews.jsonl`;
}

function reviewsAbs(repoRoot: string, brainId: string): string {
  return join(repoRoot, reviewsRel(brainId));
}

export async function loadReviews(repoRoot: string, brainId: string): Promise<Map<string, ContradictionReview>> {
  const abs = reviewsAbs(repoRoot, brainId);
  const map = new Map<string, ContradictionReview>();
  if (!existsSync(abs)) return map;
  const raw = await readFile(abs, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as ContradictionReview;
      if (row.pair_id && (row.keep === "a" || row.keep === "b" || row.keep === "both")) {
        map.set(row.pair_id, row);
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

export async function listContradictions(repoRoot: string, brainId: string): Promise<ContradictionListItem[]> {
  const abs = join(resolveBrainRoot(repoRoot, brainId), "contradictions.md");
  if (!existsSync(abs)) return [];
  let md = "";
  try {
    md = await readFile(abs, "utf8");
  } catch {
    return [];
  }
  const reviews = await loadReviews(repoRoot, brainId);
  return parseCrossFileFindings(md).map((f) => {
    const pair_id = pairIdOf(f);
    const keep = reviews.get(pair_id)?.keep;
    return { ...f, pair_id, status: keep ?? "pending" };
  });
}

function isHiddenFactStatus(status: unknown): boolean {
  return status === "archived" || status === "superseded";
}

async function markFactSuperseded(repoRoot: string, relPath: string, factIndex: number): Promise<string> {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `节点不存在: ${relPath}`);
  }
  const raw = await readFile(abs, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const facts = Array.isArray(data.facts) ? [...(data.facts as unknown[])] : [];
  const item = facts[factIndex];
  if (!item || typeof item !== "object") {
    throw new MemoryError(ErrorCodes.VALIDATION, `facts[${factIndex}] 不存在: ${relPath}`);
  }
  const rec = { ...(item as Record<string, unknown>) };
  if (!isHiddenFactStatus(rec.status)) rec.status = "superseded";
  facts[factIndex] = rec;
  data.facts = facts;
  // parse 会把 `---\n\n` 后多出来的一个换行留在 body 里；去掉后再 serialize，避免正文多空行。
  await writeFile(abs, serializeFrontmatter(data, body.replace(/^\r?\n/, "")), "utf8");
  return relPath;
}

export async function resolveContradiction(
  repoRoot: string,
  brainId: string,
  queue: FileMutationExecutor,
  input: { pairId: string; keep: ContradictionKeep; by: string },
): Promise<ContradictionListItem> {
  const items = await listContradictions(repoRoot, brainId);
  const hit = items.find((x) => x.pair_id === input.pairId);
  if (!hit) {
    throw new MemoryError(ErrorCodes.NOT_FOUND, `矛盾对不存在: ${input.pairId}`);
  }
  const review: ContradictionReview = {
    pair_id: hit.pair_id,
    keep: input.keep,
    at: new Date().toISOString(),
    by: input.by,
  };
  await queue.execute(async () => {
    const changed: string[] = [];
    if (input.keep === "a") {
      changed.push(await markFactSuperseded(repoRoot, hit.pathB, hit.factIndexB));
    } else if (input.keep === "b") {
      changed.push(await markFactSuperseded(repoRoot, hit.pathA, hit.factIndexA));
    }
    const rel = reviewsRel(brainId);
    const abs = reviewsAbs(repoRoot, brainId);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, `${JSON.stringify(review)}\n`, "utf8");
    changed.push(rel);
    return changed;
  }, `contradiction resolve ${input.pairId}`);
  return { ...hit, status: input.keep };
}
