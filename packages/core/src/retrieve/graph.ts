/**
 * P3.1 关系臂 + P7.4 邻接臂：parseRelationalQuery 或实体子串种子，links BFS depth≤2。
 * fail-open：无种子 → 空臂。
 */
import type { SqlClient } from "../index/sql.ts";
import { makeSnippet } from "./query.ts";
import type { RankedHit } from "./rrf.ts";

export interface RelationalParse {
  seed: string;
  verb: string | null;
}

export type GraphMode = "relational" | "adjacency" | "empty";

export interface GraphArmResult {
  hits: RankedHit[];
  mode: GraphMode;
}

const TEMPLATES: Array<{ re: RegExp; seedGroup: number; verb?: string }> = [
  { re: /^谁提到了\s*(.+)$/u, seedGroup: 1, verb: "mentions" },
  { re: /^谁\s*(?:负责|提到|提及)\s*(.+)$/u, seedGroup: 1, verb: "works_on" },
  { re: /^(.+?)\s*的\s*(负责人|依赖|引用)$/u, seedGroup: 1 },
  { re: /^(.+?)\s+references$/iu, seedGroup: 1, verb: "references" },
  { re: /^(.+?)\s*提到了?\s*(.+)$/u, seedGroup: 2, verb: "mentions" },
  { re: /^提到了?\s*(.+)$/u, seedGroup: 1, verb: "mentions" },
];

export function parseRelationalQuery(q: string): RelationalParse | null {
  const text = q.trim();
  if (!text) return null;
  for (const t of TEMPLATES) {
    const m = text.match(t.re);
    if (!m) continue;
    const seed = (m[t.seedGroup] ?? "").trim();
    if (!seed || seed.length > 128) continue;
    let verb = t.verb ?? null;
    if (!verb && m[2]) {
      const v = m[2];
      if (v.includes("负责")) verb = "works_on";
      else if (v.includes("依赖") || v.includes("引用")) verb = "references";
    }
    return { seed, verb };
  }
  return null;
}

export interface GraphArmOptions {
  brainId: string;
  query: string;
  limit?: number;
  sourceId?: string;
  depth?: number;
}

function parseAliasesJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function needleMatchesQuery(queryLower: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 2) return false;
  return queryLower.includes(n.toLowerCase());
}

async function collectAdjacencySeeds(db: SqlClient, brainId: string, query: string): Promise<string[]> {
  const qLower = query.trim().toLowerCase();
  if (!qLower) return [];
  const seeds = new Set<string>();

  try {
    const ents = await db.query<{ slug: string; title: string; aliases_json: string }>(
      `SELECT slug, title, aliases_json FROM entity_registry
       WHERE brain_id = $1 AND status = 'active'`,
      [brainId],
    );
    for (const e of ents.rows) {
      const names = [e.slug, e.title, ...parseAliasesJson(e.aliases_json)];
      if (names.some((n) => needleMatchesQuery(qLower, n))) seeds.add(e.slug);
    }
  } catch {
    /* 无表时 fail-open */
  }

  try {
    const refs = await db.query<{ to_ref: string }>(
      `SELECT DISTINCT to_ref FROM links WHERE brain_id = $1`,
      [brainId],
    );
    for (const r of refs.rows) {
      if (needleMatchesQuery(qLower, r.to_ref)) seeds.add(r.to_ref);
    }
  } catch {
    /* fail-open */
  }

  return [...seeds];
}

async function hitsFromSeeds(
  db: SqlClient,
  opts: GraphArmOptions,
  seeds: string[],
  verb: string | null,
): Promise<RankedHit[]> {
  const depth = Math.min(2, Math.max(1, opts.depth ?? 2));
  const limit = opts.limit ?? 30;
  const frontier = new Set<string>();
  const seedRows: Array<{ from_path: string; to_ref: string; type: string }> = [];

  for (const seed of seeds) {
    const seedLower = seed.toLowerCase();
    const rows = await db.query<{ from_path: string; to_ref: string; type: string }>(
      `SELECT from_path, to_ref, type FROM links
       WHERE brain_id = $1
         AND (lower(to_ref) = $2 OR position($3 in lower(to_ref)) > 0
              OR position($3 in lower(from_path)) > 0)`,
      [opts.brainId, seedLower, seedLower],
    );
    for (const r of rows.rows) {
      seedRows.push(r);
      frontier.add(r.from_path);
      if (r.to_ref.includes("/")) frontier.add(r.to_ref);
    }

    const titleSeeds = await db.query<{ path: string }>(
      `SELECT path FROM pages
       WHERE brain_id = $1 AND status = 'active'
         AND (position($2 in lower(title)) > 0 OR position($2 in lower(path)) > 0)
       LIMIT 20`,
      [opts.brainId, seedLower],
    );
    for (const r of titleSeeds.rows) frontier.add(r.path);
  }

  if (frontier.size === 0) return [];

  const visited = new Set<string>(frontier);
  let current = [...frontier];

  for (let d = 0; d < depth; d++) {
    if (current.length === 0) break;
    const next: string[] = [];
    for (const path of current) {
      let sql = `SELECT from_path, to_ref, type FROM links WHERE brain_id = $1 AND (from_path = $2 OR to_ref = $2)`;
      const params: unknown[] = [opts.brainId, path];
      if (verb) {
        sql += ` AND type = $3`;
        params.push(verb);
      }
      const edges = await db.query<{ from_path: string; to_ref: string; type: string }>(sql, params);
      for (const e of edges.rows) {
        for (const ref of [e.from_path, e.to_ref]) {
          if (!ref.includes("/") && !ref.endsWith(".md")) continue;
          if (visited.has(ref)) continue;
          visited.add(ref);
          next.push(ref);
        }
        if (!e.to_ref.includes("/")) {
          if (!visited.has(e.from_path)) {
            visited.add(e.from_path);
            next.push(e.from_path);
          }
        }
      }
    }
    current = next;
  }

  const paths = [...visited].filter((p) => p.includes("/") || p.endsWith(".md"));
  if (paths.length === 0) {
    paths.push(...new Set(seedRows.map((r) => r.from_path)));
  }
  if (paths.length === 0) return [];

  const placeholders = paths.map((_, i) => `$${i + 2}`).join(", ");
  let pageSql = `SELECT path, title, body_text, source_id FROM pages
      WHERE brain_id = $1 AND status = 'active' AND path IN (${placeholders})`;
  const pageParams: unknown[] = [opts.brainId, ...paths];
  if (opts.sourceId) {
    pageSql += ` AND source_id = $${pageParams.length + 1}`;
    pageParams.push(opts.sourceId);
  }
  const pages = await db.query<{ path: string; title: string; body_text: string; source_id: string }>(
    pageSql,
    pageParams,
  );

  const snippetSeed = seeds[0] ?? opts.query;
  const hits: RankedHit[] = pages.rows.map((p, i) => ({
    path: p.path,
    score: 1 / (i + 1),
    title: p.title,
    snippet: makeSnippet(p.body_text, snippetSeed),
    evidence: ["graph"],
  }));

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}

/**
 * 关系臂优先；否则邻接臂（entity slug/title/alias 或 links.to_ref 子串命中）。
 */
export async function graphArmDetailed(db: SqlClient, opts: GraphArmOptions): Promise<GraphArmResult> {
  try {
    const parsed = parseRelationalQuery(opts.query);
    if (parsed) {
      const hits = await hitsFromSeeds(db, opts, [parsed.seed], parsed.verb);
      return { hits, mode: "relational" };
    }
    const seeds = await collectAdjacencySeeds(db, opts.brainId, opts.query);
    if (seeds.length === 0) return { hits: [], mode: "empty" };
    const hits = await hitsFromSeeds(db, opts, seeds, null);
    return { hits, mode: hits.length > 0 ? "adjacency" : "empty" };
  } catch {
    return { hits: [], mode: "empty" };
  }
}

export async function graphArm(db: SqlClient, opts: GraphArmOptions): Promise<RankedHit[]> {
  return (await graphArmDetailed(db, opts)).hits;
}
