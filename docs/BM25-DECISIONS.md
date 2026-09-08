# BM25 决策记录

> 规则：只有用户明确说“记录”时才追加条目；平时讨论不写入。

## 决策

### D1（2026-09-06）：中英文分开处理，统一建索引
- 英文：用 PG/PGLite 内置 `english` 配置（stem + 停用 + `websearch_to_tsquery` + `setweight` 权重 + `GIN` 召回）。
- 中文：保留自有逻辑（`bigram` + `position` 子串兜底）。
- 写入：`syncPage` 同一事务写两套列；查询：双臂召回后 `RRF` 融合。
- 参考：`D:\memory_projects\gbrain\src\schema.sql:362-364,847-849`（`setweight(to_tsvector('english',...),'A'/'B'/'C')`物化列）；`src/core/pglite-engine.ts:1689,1812` / `src/core/postgres-engine.ts:1791,1947`（`websearch_to_tsquery + ts_rank × sourceFactor`）；`src/core/fts-language.ts:25`（`GBRAIN_FTS_LANGUAGE` 默认 `english`）；CJK 兜底 `src/core/pglite-engine.ts:1845-1924`（`_searchKeywordCJK`）。

### D2（2026-09-06）：摄入与查询同改
- 摄入文本处理（清洗规则/分词切法/`simple`→`english`配置/代码与停用词取舍）与问句处理逻辑必须同一套，否则存查失配。
- 落点：`packages/core/src/index/sync.ts` + `packages/core/src/retrieve/query.ts` + `packages/core/src/index/schema.sql` 三件套同改，老数据 `rebuild-index` 全量回填。
