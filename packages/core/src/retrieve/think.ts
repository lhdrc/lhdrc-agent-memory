import type { PGlite } from "@electric-sql/pglite";
import { hybridQueryDetailed, type HybridQueryOptions } from "./hybrid.ts";
import type { QueryHit } from "./query.ts";

export interface ThinkHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

export interface ThinkResult {
  query: string;
  skills: ThinkHit[];
  experiences: ThinkHit[];
  notes: ThinkHit[];
  hints: string[];
}

function toHit(h: QueryHit): ThinkHit {
  return { path: h.path, title: h.title, score: h.score, snippet: h.snippet };
}

function bucket(path: string): "skills" | "experiences" | "notes" {
  const p = path.replace(/\\/g, "/");
  if (p.includes("/skills/")) return "skills";
  if (p.includes("/experiences/")) return "experiences";
  return "notes";
}

export async function thinkQuery(
  db: PGlite,
  opts: Pick<HybridQueryOptions, "brainId" | "repoRoot" | "search" | "embedder" | "intentLexicon"> & {
    query: string;
    limit?: number;
  },
): Promise<ThinkResult> {
  const q = opts.query.trim();
  const { hits } = await hybridQueryDetailed(db, {
    brainId: opts.brainId,
    query: q,
    limit: opts.limit ?? 20,
    repoRoot: opts.repoRoot,
    search: opts.search,
    embedder: opts.embedder,
    intentLexicon: opts.intentLexicon,
    skipCache: true,
  });

  const skills: ThinkHit[] = [];
  const experiences: ThinkHit[] = [];
  const notes: ThinkHit[] = [];
  for (const h of hits) {
    const item = toHit(h);
    const b = bucket(h.path);
    if (b === "skills") skills.push(item);
    else if (b === "experiences") experiences.push(item);
    else notes.push(item);
  }

  const hints: string[] = [];
  if (skills.length === 0 && experiences.length === 0 && notes.length === 0) {
    hints.push("cold_start");
  }

  return { query: q, skills, experiences, notes, hints };
}
