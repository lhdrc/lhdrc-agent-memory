/**
 * P3.1：将抽链结果写入 links 表（删旧插新）。
 */
import type { SqlClient } from "./sql.ts";
import { sha256Hex } from "../util/hash.ts";
import { extractEntityRefs, type ExtractedLink } from "../graph/link-extraction.ts";

export function linkRowId(fromPath: string, to: string, type: string, source: string): string {
  return sha256Hex(`${fromPath}\0${to}\0${type}\0${source}`);
}

export async function deleteLinksForPath(db: SqlClient, fromPath: string): Promise<void> {
  await db.query(`DELETE FROM links WHERE from_path = $1`, [fromPath]);
}

/** 删 from_path 旧边，再插入新边。 */
export async function syncLinksForPage(
  db: SqlClient,
  fromPath: string,
  body: string,
  frontmatter: Record<string, unknown>,
  brainId: string,
  verbPatterns?: Array<{ re: RegExp; type: string }>,
): Promise<ExtractedLink[]> {
  const fmLinks = Array.isArray(frontmatter.links)
    ? (frontmatter.links as Array<{ to?: unknown; type?: unknown; source?: unknown }>)
    : null;
  const links = extractEntityRefs(body, fmLinks, verbPatterns ? { verbPatterns } : undefined);
  await deleteLinksForPath(db, fromPath);
  for (const l of links) {
    const id = linkRowId(fromPath, l.to, l.type, l.source);
    await db.query(
      `INSERT INTO links (id, from_path, to_ref, type, source, brain_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, fromPath, l.to, l.type, l.source, brainId],
    );
  }
  return links;
}
