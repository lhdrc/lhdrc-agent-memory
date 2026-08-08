/**
 * P3.1 关系臂：parseRelationalQuery + links BFS depth≤2。
 * fail-open：解析失败 → 空臂。
 */
import type { PGlite } from "@electric-sql/pglite";
import { makeSnippet } from "./query.ts";
import type { RankedHit } from "./rrf.ts";

export interface RelationalParse {
  seed: string;
  verb: string | null;
}

const TEMPLATES: Array<{ re: RegExp; seedGroup: number; verb?: string }> = [
  { re: /^谁\s*(?:负责|提到|提及)\s*(.+)$/u, seedGroup: 1, verb: "works_on" },
  { re: /^谁提到了\s*(.+)$/u, seedGroup: 1, verb: "mentions" },
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

/**
 * 关系臂：解析失败返回 []（fail-open）。
 * BFS 从与 seed 匹配的 to_ref / from_path / title 出发，沿 links 扩 depth≤2。
 */
export async function graphArm(db: PGlite, opts: GraphArmOptions): Promise<RankedHit[]> {
  try {
    const parsed = parseRelationalQuery(opts.query);
    if (!parsed) return [];

    const depth = Math.min(2, Math.max(1, opts.depth ?? 2));
    const limit = opts.limit ?? 30;
    const seed = parsed.seed;
    const seedLower = seed.toLowerCase();

    // 种子：to_ref 命中，或 path/title 含子串
    const seedRows = await db.query<{ from_path: string; to_ref: string; type: string }>(
      `SELECT from_path, to_ref, type FROM links
       WHERE brain_id = $1
         AND (lower(to_ref) = $2 OR position($3 in lower(to_ref)) > 0
              OR position($3 in lower(from_path)) > 0)`,
      [opts.brainId, seedLower, seedLower],
    );

    const frontier = new Set<string>();
    for (const r of seedRows.rows) {
      frontier.add(r.from_path);
      // to_ref 可能是 path
      if (r.to_ref.includes("/")) frontier.add(r.to_ref);
    }

    // 也从 pages title 找种子 path
    const titleSeeds = await db.query<{ path: string }>(
      `SELECT path FROM pages
       WHERE brain_id = $1 AND status = 'active'
         AND (position($2 in lower(title)) > 0 OR position($2 in lower(path)) > 0)
       LIMIT 20`,
      [opts.brainId, seedLower],
    );
    for (const r of titleSeeds.rows) frontier.add(r.path);

    if (frontier.size === 0) return [];

    const visited = new Set<string>(frontier);
    let current = [...frontier];

    for (let d = 0; d < depth; d++) {
      if (current.length === 0) break;
      const next: string[] = [];
      for (const path of current) {
        let sql = `SELECT from_path, to_ref, type FROM links WHERE brain_id = $1 AND (from_path = $2 OR to_ref = $2)`;
        const params: unknown[] = [opts.brainId, path];
        if (parsed.verb) {
          sql += ` AND type = $3`;
          params.push(parsed.verb);
        }
        const edges = await db.query<{ from_path: string; to_ref: string; type: string }>(sql, params);
        for (const e of edges.rows) {
          for (const ref of [e.from_path, e.to_ref]) {
            if (!ref.includes("/") && !ref.endsWith(".md")) continue; // slug-only：不当 path 扩
            if (visited.has(ref)) continue;
            visited.add(ref);
            next.push(ref);
          }
          // slug → 链入该 slug 的 from_path 已在 from_path 侧
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
      // 仅有 slug 命中：返回链入页
      const mentionPages = seedRows.rows.map((r) => r.from_path);
      paths.push(...new Set(mentionPages));
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

    const hits: RankedHit[] = pages.rows.map((p, i) => ({
      path: p.path,
      score: 1 / (i + 1),
      title: p.title,
      snippet: makeSnippet(p.body_text, seed),
      evidence: ["graph"],
    }));

    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
  } catch {
    return [];
  }
}
