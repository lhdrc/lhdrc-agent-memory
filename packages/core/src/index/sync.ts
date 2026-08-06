import { join, basename, relative } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { MemoryError, ErrorCodes } from "../errors.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { fileToEntity } from "../entity/files.ts";
import { sha256Hex } from "../util/hash.ts";
import { bigrams } from "../retrieve/ngrams.ts";
import { resolveBrainRoot } from "../repo/layout.ts";
import { writeIndexMeta } from "./meta.ts";

export const PAGE_COLS = [
  "path",
  "brain_id",
  "source_id",
  "schema_type",
  "title",
  "status",
  "aliases_json",
  "frontmatter_json",
  "body_text",
  "content_hash",
  "updated_at",
  "fts_title",
  "fts_body",
  "title_ngrams",
  "body_ngrams",
];

/** 按段落优先分块，单块 ≤ maxLen。 */
export function chunkText(text: string, maxLen = 800): string[] {
  const paras = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      let rest = trimmed;
      while (rest.length > maxLen) {
        chunks.push(rest.slice(0, maxLen));
        rest = rest.slice(maxLen);
      }
      if (rest) chunks.push(rest);
      continue;
    }
    if (cur && cur.length + trimmed.length + 2 > maxLen) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${trimmed}` : trimmed;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 增量同步单个 page 文件；文件被物理删除时软删除索引行。 */
export async function syncPage(db: PGlite, repoRoot: string, relPath: string): Promise<void> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    await db.query(`DELETE FROM pages WHERE path = $1`, [relPath]);
    return;
  }
  const hash = sha256Hex(raw);
  const existing = await db.query<{ content_hash: string }>(`SELECT content_hash FROM pages WHERE path = $1`, [relPath]);
  if (existing.rows.length > 0 && existing.rows[0]!.content_hash === hash) return;

  const { data, body } = parseFrontmatter(raw);
  const title = String(data.title ?? basename(relPath, ".md"));
  const status = String(data.status ?? "active");
  const sourceId = (data.source as string) ?? sourceIdFromPath(relPath);
  const schemaType = data.schema_type as string | undefined;
  const brainId = brainIdFromPath(relPath);
  const updatedAt = new Date().toISOString();
  const aliasesJson = JSON.stringify(Array.isArray(data.aliases) ? data.aliases : []);
  const frontmatterJson = JSON.stringify(data);
  const titleNgrams = bigrams(title);
  const bodyNgrams = bigrams(body);

  await db.exec("BEGIN");
  try {
    await db.query(
      `INSERT INTO pages (${PAGE_COLS.join(", ")})
       VALUES (${PAGE_COLS.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT (path) DO UPDATE SET
         brain_id = EXCLUDED.brain_id,
         source_id = EXCLUDED.source_id,
         schema_type = EXCLUDED.schema_type,
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         aliases_json = EXCLUDED.aliases_json,
         frontmatter_json = EXCLUDED.frontmatter_json,
         body_text = EXCLUDED.body_text,
         content_hash = EXCLUDED.content_hash,
         updated_at = EXCLUDED.updated_at,
         fts_title = EXCLUDED.fts_title,
         fts_body = EXCLUDED.fts_body,
         title_ngrams = EXCLUDED.title_ngrams,
         body_ngrams = EXCLUDED.body_ngrams`,
      [relPath, brainId, sourceId, schemaType, title, status, aliasesJson, frontmatterJson, body, hash, updatedAt, title, body, titleNgrams, bodyNgrams],
    );
    await db.query(`DELETE FROM chunks WHERE path = $1`, [relPath]);
    const chunks = chunkText(body);
    for (let i = 0; i < chunks.length; i++) {
      await db.query(`INSERT INTO chunks (id, path, chunk_index, text) VALUES ($1, $2, $3, $4)`, [
        `${relPath}#${i}`,
        relPath,
        i,
        chunks[i]!,
      ]);
    }
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw new MemoryError(ErrorCodes.INDEX, `同步 page 失败 ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 增量同步单个 entity 文件。 */
export async function syncEntity(db: PGlite, repoRoot: string, relPath: string): Promise<void> {
  const abs = join(repoRoot, relPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    await db.query(`DELETE FROM entity_registry WHERE slug = $1`, [entitySlugFromPath(relPath)]);
    return;
  }
  const entity = fileToEntity(raw);
  const hash = sha256Hex(raw);
  const canonical = entity.status === "merged" ? (entity.redirect ?? entity.slug) : entity.slug;
  const aliasesJson = JSON.stringify([...new Set([entity.slug, ...entity.aliases])]);
  const updatedAt = new Date().toISOString();
  await db.query(
    `INSERT INTO entity_registry (slug, canonical_slug, status, title, aliases_json, content_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET
       canonical_slug = EXCLUDED.canonical_slug,
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       aliases_json = EXCLUDED.aliases_json,
       content_hash = EXCLUDED.content_hash,
       updated_at = EXCLUDED.updated_at`,
    [entity.slug, canonical, entity.status, entity.title, aliasesJson, hash, updatedAt],
  );
}

function brainIdFromPath(relPath: string): string {
  const parts = relPath.split("/");
  return parts[1] ?? "default";
}

function sourceIdFromPath(relPath: string): string {
  const parts = relPath.split("/");
  const idx = parts.indexOf("sources");
  return idx >= 0 && parts[idx + 1] ? (parts[idx + 1] ?? "default") : "default";
}

function entitySlugFromPath(relPath: string): string {
  return basename(relPath, ".md");
}

/** 全量扫描 brain：sources/**\/*.md + entities/*.md。 */
export async function syncAll(db: PGlite, repoRoot: string, brainId: string): Promise<{ fileCount: number }> {
  await ensureSchemaForSync(db);
  const brainRoot = resolveBrainRoot(repoRoot, brainId);
  const sourceRoot = join(brainRoot, "sources");
  const sourceRel = `brains/${brainId}/sources`;
  const pageFiles: string[] = [];
  if (existsSync(sourceRoot)) {
    await walkMd(sourceRoot, sourceRel, pageFiles);
  }
  for (const rel of pageFiles) {
    await syncPage(db, repoRoot, rel);
  }
  const entityDir = join(brainRoot, "entities");
  if (existsSync(entityDir)) {
    const entries = (await readdir(entityDir)).filter((f) => f.endsWith(".md"));
    for (const f of entries) {
      await syncEntity(db, repoRoot, `brains/${brainId}/entities/${f}`);
    }
  }
  const count = await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pages`);
  const fileCount = Number(count.rows[0]?.n ?? 0);
  await writeIndexMeta(repoRoot, { schemaVersion: 1, lastSyncAt: new Date().toISOString(), fileCount, engine: "pglite" });
  return { fileCount };
}

async function ensureSchemaForSync(db: PGlite): Promise<void> {
  const { ensureSchema } = await import("./engine.ts");
  await ensureSchema(db);
}

async function walkMd(dirAbs: string, baseRel: string, out: string[]): Promise<void> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childAbs = join(dirAbs, e.name);
    const childRel = `${baseRel}/${e.name}`;
    if (e.isDirectory()) {
      await walkMd(childAbs, childRel, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(childRel);
    }
  }
}
