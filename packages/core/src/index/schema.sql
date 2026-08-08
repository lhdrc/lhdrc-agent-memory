-- PGLite 索引 DDL（specs/mvp/M3 §4）

CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,
  brain_id TEXT NOT NULL,
  source_id TEXT,
  schema_type TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  body_text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL REFERENCES pages(path) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  text TEXT NOT NULL,
  embedding BYTEA
);

CREATE TABLE IF NOT EXISTS entity_registry (
  brain_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  canonical_slug TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brain_id, slug)
);

ALTER TABLE pages ADD COLUMN IF NOT EXISTS fts_title TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS fts_body TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS title_ngrams TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_ngrams TEXT;

-- P3.1：零 LLM 建图 + 查询缓存
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  from_path TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  brain_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_from ON links(from_path);
CREATE INDEX IF NOT EXISTS links_to ON links(to_ref);
CREATE INDEX IF NOT EXISTS links_brain ON links(brain_id);

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key TEXT PRIMARY KEY,
  knobs_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
