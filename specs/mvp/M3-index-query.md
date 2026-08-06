# Spec M3 — PGLite 索引、BM25 查询、rebuild

| 字段 | 值 |
|---|---|
| ID | M3 |
| 状态 | ready |
| 依赖 | M2 |
| 对应架构 | 08 §5.2（子集）、§5.3、§5.4、§18.2 检索面；**D1/D18**（索引派生，写路径不依赖 git commit） |

## 1. 目标

1. PGLite 最小 schema：`pages` / `chunks` / `entity_registry`  
2. 文件变更后增量同步；`rebuild-index` 全量重建  
3. `memory query`：BM25（FTS）+ 标题/路径加权；默认排除 archived  
4. 验收：删索引后 rebuild，query 语义一致；entity merge 后 rebuild resolve 仍正确  

## 2. 非目标

- embedding 列可存在但 **MVP 不计算、不查询**  
- RRF / 图谱 / links 表 / facts 独立表（facts 可内嵌 pages frontmatter JSON）  
- search_cache、rerank  

## 3. 包落点

```
packages/core/src/index/
  engine.ts          # openPglite(repoRoot)
  schema.sql         # DDL
  sync.ts            # upsertFromFile / softDelete
  rebuild.ts
  hooks.ts           # 实现 M2 onFilesWritten（可别名 onFilesCommitted）
packages/core/src/retrieve/
  query.ts           # bm25Query
  rank.ts            # title/path boost
packages/cli/src/commands/
  query.ts
  rebuild-index.ts
```

## 4. DDL（PGLite）

```sql
CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,           -- 相对 repo 根，POSIX
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
  id TEXT PRIMARY KEY,             -- path + '#' + chunk_index
  path TEXT NOT NULL REFERENCES pages(path) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  text TEXT NOT NULL,
  -- embedding 预留：MVP 恒 NULL
  embedding BYTEA
);

CREATE TABLE IF NOT EXISTS entity_registry (
  slug TEXT PRIMARY KEY,
  canonical_slug TEXT NOT NULL,    -- 活实体 = 自己；merged = redirect 目标
  status TEXT NOT NULL,            -- active | merged
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FTS：用 plainto_tsquery + to_tsvector('simple')
-- 中文：额外维护 title_ngrams / body_ngrams 列（空格分隔 bigram），见 §6
ALTER TABLE pages ADD COLUMN IF NOT EXISTS fts_title TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS fts_body TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS title_ngrams TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_ngrams TEXT;
```

`index-meta.json`：

```json
{
  "schemaVersion": 1,
  "lastSyncAt": "ISO",
  "fileCount": 0,
  "engine": "pglite"
}
```

## 5. 同步规则

### 5.1 哪些文件进 pages

- `brains/{brain}/sources/**/*.md` 且非隐藏  
- **不含** `entities/`（实体只进 entity_registry）  
- experiences/skills 空壳可跳过或进 pages（MVP：**跳过**非 sources 下 md，除将来扩展）  

### 5.2 upsert 算法

```
read file → hash
if hash == pages.content_hash → skip
parse frontmatter + body
upsert pages
delete chunks where path=...
chunk body by ~800 chars / 段落优先 → insert chunks
```

archived：`status='archived'` 仍保留行，query 默认 `WHERE status='active'`。

### 5.3 softDelete

文件从工作区物理删除时（MVP forget 不删文件）：若将来物理删，则 `DELETE FROM pages WHERE path=?`（CASCADE chunks）。与是否已 git commit 无关。

### 5.4 entity_registry 同步

扫 `brains/{id}/entities/*.md`：

- active → `canonical_slug = slug`  
- merged → `canonical_slug = redirect`  
- aliases_json 含自身 slug + aliases  

`resolve`：M3 起 **先查表**，miss 再扫文件（与 M1 兼容）。

### 5.5 Hook

> 在文件**已落盘**后调用（D18：可能尚未 `git commit`）。语义是「工作区已变」，不是「账本已提交」。  
> 实现可保留别名 `onFilesCommitted`，但文档与测试按「写后同步」理解。

```ts
async function onFilesWritten(repoRoot: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    if (p.includes("/entities/")) await syncEntity(p);
    else if (p.endsWith(".md") && p.includes("/sources/")) await syncPage(p);
  }
  update index-meta.json
}
```

失败时：抛错由 WriteQueue 捕获为 warn，**禁止**回滚已写 md（D1）。

## 6. 中文与 BM25

PGLite/`simple` 配置对中文分词弱。MVP 强制：

1. **生成 ngrams**：对 title/body 去空白后，按字符 bigram 切开，空格连接存入 `title_ngrams` / `body_ngrams`  
   - 例：`重试策略` → `重试 试策 策略`  
2. 查询串同样 bigram 化  
3. SQL 相关性（示意）：

```sql
SELECT path, title,
  (
    3.0 * ts_rank(to_tsvector('simple', coalesce(fts_title,'')), plainto_tsquery('simple', $q))
  + 1.0 * ts_rank(to_tsvector('simple', coalesce(fts_body,'')), plainto_tsquery('simple', $q))
  + 2.0 * ts_rank(to_tsvector('simple', coalesce(title_ngrams,'')), plainto_tsquery('simple', $qng))
  + 0.8 * ts_rank(to_tsvector('simple', coalesce(body_ngrams,'')), plainto_tsquery('simple', $qng))
  + CASE WHEN title ILIKE '%' || $raw || '%' THEN 2.5 ELSE 0 END
  + CASE WHEN path ILIKE '%' || $raw || '%' THEN 1.5 ELSE 0 END
  ) AS score
FROM pages
WHERE status = 'active' AND brain_id = $brain
ORDER BY score DESC
LIMIT $limit;
```

英文查询仍受益于 `simple` FTS；中文主要靠 ngrams + ILIKE。

## 7. query CLI

```
memory query <text> [--limit 10] [--source <id>] [--json]
```

输出（人类可读默认）：

```
1. 0.91  sources/default/issues/general/decisions/1-retry.md
   重试策略调整
   ...snippet...
```

`--json`：

```json
{
  "query": "重试",
  "results": [
    {
      "path": "...",
      "title": "...",
      "score": 0.91,
      "snippet": "...",
      "evidence": ["keyword", "title"]
    }
  ]
}
```

MVP `evidence` 可简化为固定含 `keyword`；命中标题加 `title`，命中路径加 `path`。

## 8. rebuild-index

```
memory rebuild-index [--force]
```

步骤：

1. 关连接 / 删 `.dfmemory/pglite` 目录（或 DROP 全表）  
2. 重新执行 DDL  
3. 全量扫 sources/**/*.md + entities/*.md  
4. 写 index-meta  

**验收铁律**：rebuild 前后 `query` 对同一探针集合返回相同 path 集合（允许 score 浮点差）。

## 9. 与 entity merge 联合验收

```
merge → query 不要求搜到实体页
resolve loser → canonical
rm -rf .dfmemory/pglite && rebuild-index
resolve loser → canonical   # 必须仍成立
```

## 10. 验收用例

| ID | Given | When | Then |
|---|---|---|---|
| M3-01 | capture 含「重试」 | query 重试 | top 结果含该 path |
| M3-02 | 同上 | 删 pglite 后 rebuild 再 query | 仍含该 path |
| M3-03 | forget 节点 | query | 默认结果集不含该 path |
| M3-04 | 未改文件再 sync | | content_hash 跳过，无错误 |
| M3-05 | entity merge + rebuild | resolve | canonical 正确 |
| M3-06 | 中文标题「支付网关超时」 | query「网关」 | 能命中（ngram） |
| M3-07 | capture 后未手工 rebuild | query | 因 hook 已增量同步，可命中（**不依赖** git commit / `sync --commit`） |

## 11. DoD

- [ ] PGLite 在干净机器零配置可跑  
- [ ] M3-01…07 自动化测试通过  
- [ ] MVP 总验收口令（见 mvp/README）全绿  
- [ ] README 示例：`init → capture → query → rebuild-index`  

## 12. MVP 完成标志

M1+M2+M3 DoD 全部勾选后，**MVP 可发布 pre-alpha CLI**。此后进入 `specs/二期/`。
