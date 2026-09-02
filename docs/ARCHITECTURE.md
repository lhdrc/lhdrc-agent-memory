# df-memory 架构文档

> 版本：十三期 P13.1-5 done（BM25 GIN、图 10 边、History 正排、Prompt Codex、真矛盾）  
> 对应：`reports/08-开源记忆模块设计方案.md`（ADR） + `specs/十三期/` + `AGENTS.md`

## 1. 定位与约束

- **一句话**：开源、单机、本地部署的记忆仓——`md 文件是真相，索引可重建，git 是可选账本`。
- **硬约束**：`D1 文件真相 / D2 brain 路径隔离 / D13 merge 文件事务 / D14 WRITE_FORMAT / D17 L0 ADD-only / D18 批量账本`（`08 §0`）。
- **技术栈**：TypeScript strict + Bun + PGLite（WASM Postgres，零配置）↔ Postgres（`index.engine: postgres` + `DF_MEMORY_DATABASE_URL`）。

## 2. 总体分层

```
┌─────────────────────────────────────────────────────────┐
│  接入层：CLI (memory) / DSH 插件 (memory_query/remember) │
├─────────────────────────────────────────────────────────┤
│  服务层：WriteQueue(单写者锁) / Retrieve(hybrid) /       │
│         Distill(refine) / Crystallize / Dream(5段)      │
├─────────────────────────────────────────────────────────┤
│  存储层：md 文件树（brains/{id}/sources|entities|…）    │
│         索引：PGLite pages/chunks/links/entity_registry  │
│         账本：git batch（N=20/T=5m/force）               │
└─────────────────────────────────────────────────────────┘
```

## 3. 存储设计

### 3.1 文件树（权威）

```
memory-root/
├── memory.yml
├── .dfmemory/{pglite/,inbox/sessions/*/messages.jsonl,jobs/,history_index.jsonl}
└── brains/{brainId}/
    ├── brain.yml
    ├── sources/{sourceId}/issues/{id}/decisions/*.md  # frontmatter: title/schema_type/path/source/tags/links/facts/provenance
    ├── entities/{slug}.md                              # redirect  stub
    ├── experiences/{id}.md
    ├── skills/{name}/SKILL.md
    └── contradictions.md + contradictions-reviews.jsonl
```

### 3.2 索引（派生）

| 表 | 列 | 用途 |
|---|---|---|
| `pages` | `path, brain_id, source_id, title, body_text, fts_title/body（清洗后）, title/body_ngrams（bigrams）, content_hash` | BM25 文章级 |
| `chunks` | `id=path#i, text, embedding BYTEA(Float32LE)` | 向量 `max-pool` per path |
| `links` | `from_path, to_ref, type, source, brain_id` | 图 `BFS depth≤2` |
| `entity_registry` | `slug, canonical_slug, status` | 去重 |
| `search_cache` | `knobs_hash` | 防污染 |

- **GIN**（P13.1）：`pages_fts_title/body/title/body_ngrams_gin ON to_tsvector('simple', col)`。
- **清洗**：`cleanForIndex`（`stripCodeBlocks`→去`[]()`/`[[`→NFKC→空白归一）后写 `fts_*`/`ngrams`，`body_text` 留原文供 `snippet`。
- **Hash**：`pickSemanticFrontmatter` 白名单（`content-hash.ts:20`），`provenance/history` 不进。

## 4. 数据流

### 4.1 写（D18）

```
持锁 → 写 md → content_hash 增量 sync（hash 同跳过）→ 标记 dirty
     → force(merge/schema/purge) 立即 commit / 否则 batch N/T/退出/sync --commit
     → onFilesWritten: syncPage（page+chunks 分事务，embed 失败留 NULL 供 --pending-embeddings）
```

- **Inbox**：`archiveSession` 落 `messages.jsonl`，`compileSession` 经 `complete()` 填 `items` + `source_turns`，同事务 `appendHistoryEntries` 写 `history_index.jsonl` + `frontmatter.provenance`。
- **ADD-only**：L0 不覆盖；`duplicate` 靠 `checkDedupe cosine≥0.95 + isObjectValueConflict`。

### 4.2 读（混合检索）

```
query → intent(正则) → 三臂并行
  ① BM25: to_tsvector('simple', fts_*) + ngrams + position + power(len,0.3)归一 + phraseto
  ② 向量: chunks embedding Float32视图 → max-pool per path（P12.1 瘦 SELECT）
  ③ 图: parseRelationalQuery 10 模板 → hitsFromSeeds(BFS+type过滤) / adjacency
→ RRF*(k+1) + per_arm/fused floor → cosine 0.7/0.3 → graph signals → hotness* (freq×recency α=0.15) → tier tie-break → L0/L1 snippet
→ cache(knobs_hash)
```

### 4.3 维护（Dream 5 段）

`lint / sync / distill_pending / contradictions / orphans`（AGENTS 硬约束不扩 9 段）

- **P13.5 真矛盾**：实体桶 `k=5` + `cosine≥0.95` 直判 + `值冲突/否定` 二筛 + 灰区 `0.92-0.95` 批量 `LLM triage`（`duplicate|supersede|independent`）+ `local` 规则分支；落 `contradictions.md ##cross-file contradiction supersede→` + 预填 `facts.supersedes`，人审 `contradiction resolve` 后 `superseded` 剔索引 `*0`。

## 5. 核心模块映射

| 模块 | 路径 | 职责 |
|---|---|---|
| 索引 | `index/schema.sql` + `engine.ts` + `sync.ts` + `engine.ts:ensureSchema` | 表/GIN/幂等 |
| 检索 | `retrieve/query.ts` + `semantic.ts` + `graph.ts` + `rrf.ts` + `hybrid.ts` | 三臂+融合 |
| 清洗 | `retrieve/clean.ts` | `cleanForIndex` |
| 写入 | `write/capture.ts` + `write/queue.ts` + `write/validator.ts` | 校验+事务 |
| 会话 | `inbox/session.ts` + `compile/session.ts` + `history/index.ts` | inbox/history |
| Prompt | `resources/session-extract-v1.md` + `abstract/overview-v1.md` | `NO-OP/4桶` |
| 矛盾 | `dream/runner.ts` + `contradiction/*` + `retrieve/stale.ts` | 标/审/降权 |
| CLI | `cli/commands/*` + `cli/run.ts` | `read --with-history` / `history` / `contradiction` / `config` |

## 6. 演进与裁剪

- **已做**：十三期 `P13.1-5`、`P12.1-3`、`P11.1-7`、`P10.2-4`、`P9.1-9` 等（`AGENTS.md` 表）。
- **明确不做**：`#9 HNSW vector列`、`全量 O(n²) LLM`、`local 强行 LLM`、`MCP/REST`（P4.1）、`Cursor 模板`（P6.5）、`Java` 并行。
- **可丢**：`pglite/`、`jobs/`、`index-meta`、`history_index` 重建于文件；未 `flush` 的 `dirty` 仅丢版本史。

## 7. 验证

`bun test packages/core/tests/`（含 `p131 4/4`、`p132 3/3`、`p133 3/3`、`p134 3/3`、`p135 3/3`）、`test:isolation`、 `eval:mini`。

## 8. 参考

- `reports/08` ADR 全表
- `specs/十三期/README.md` + `TODO.md #51-55`
- `gbrain/src/core/facts/classify.ts:3`（真矛盾对标）、`codex-rs` Prompt（`stage_one_system.md`）
