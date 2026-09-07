# Design: 中英混合文本处理（摄入清洗 + 分流分词 + 检索对称）

- 日期：2026-09-07
- 基线：P13.1 done（`specs/十三期/P13.1-bm25-article.md`），只动 BM25 臂，`chunks` 仍仅服务语义臂
- 对应文件：`packages/core/src/retrieve/clean.ts`、`retrieve/ngrams.ts`、`retrieve/query.ts`、`index/sync.ts`、`index/schema.sql`、`index/engine.ts`

## 1. 背景与问题

1. `bigrams()`（`retrieve/ngrams.ts:2`）把全部空格删除后滑 2 字窗，英文单词边界被打碎（`retry strategy` → `re/et/...`）。
2. 全库用 `to_tsvector('simple', ...)`（`retrieve/query.ts:77-82`、`schema.sql:63-66`），无词干、无停用词，`retrying` 查不到 `retries`。
3. 不对称：摄入走 `cleanForIndex`，检索 `qng = bigrams(q)` 用裸查询（`query.ts:62`）；`clean.ts` 注释写 lower 但代码缺 `.toLowerCase()`。

## 2. 目标

1. 中文维持字二元（PGlite 装不了 zhparser 类扩展；P13.1 非目标含 jieba 重分词）。
2. 英文吃 PGlite 原生 `english` 配置（小写 + snowball 词干 + 停用词，已实测验证）。
3. 摄入与检索调同一个分词函数；双引擎（pglite/postgres）共 `schema.sql`，`ensureSchema` 幂等，一次 `rebuild-index` 回填。

## 3. 非目标

- 自建 posting list、jieba 重分词、chunks 进 BM25（沿用 P13.1 §2）。
- 同义词/拼写纠错/模糊、前缀检索、简繁转换、拼音（记入 §7 P1 backlog）。
- 清洗结果进 `content_hash`（白名单外，沿用 P13.1）。

## 4. 管线设计

### 4.1 归一（`cleanForIndex` 修补）

`NFKC → lower（补上）→ 全半角 → stripCodeBlocks → 去 md 噪声（图片/链接/wikilink/@slug 保留文本，去 #>列表格线|`/反引号）→ 空白归一 → bm25 额外符号清理`。
PG 不做 NFKC/全半角（已实测全角原样留存），所以归一必须留 JS 侧。

### 4.2 分流（新增 `retrieve/tokenize.ts`，`sync.ts` 与 `query.ts` 双边调用）

- 英文流：`[a-z0-9]+(?:'[a-z]+)?` 抽词，连字符/下划线当分隔（与 PG `english` parser 一致，`Retry-Strategy` 双存整形+拆分）。
- 中文流：`[\p{Script=Han}]` 抽汉字序列，内部去空格后滑字二元（现有逻辑不变，输入收窄为汉字流）。
- 数字归英文流；字母数字混排（`P13.1`、`v2`）整形+拆分双存。
- 整篇不判语言，按字级别按 Unicode 脚本分流（混合句是常态）。

### 4.3 存储（双路并存）

- `fts_title/fts_body` 保留空格原文不动（供 `simple` + `phraseto_tsquery` 字面召回）。
- `title_ngrams/body_ngrams` 改为仅汉字流二元（英文不再被打碎）。
- 新增英文词串列（或 SQL 内 `to_tsvector('english', en_text)` 表达式索引二选一，实施时定；推荐新增列，回填与排障更直观）。
- 新增 GIN：`to_tsvector('english', en_title)` / `en_body`；现有 4 个 GIN 不动。`RRF k=60` 不动，P13.1 权重 `3.0/1.0/2.0/0.8` 不动，`english` 另给小权重起步（如 title/body `1.2/0.6`，可调）。

### 4.4 检索对称

`query.ts` 对查询串同样先 `cleanForIndex(q,'bm25')` 再 `tokenizeMixed`，三路加权：`simple`（字面）+ `english`（词干）+ `ngram`（中文二元），保留 `position(lower(title))` 兜底。`--explain` 透出各路贡献（沿用 P10.4 score_details 思路）。

### 4.5 BM25 统计（真打分要的 4 个数，分两步上）

- `tf`（词在这篇出现几次）：新增 `terms(path, field, term, tf)`，`field ∈ {title,body}`，`term` 存归一后未 stem 形（stem 交给查询时 PG `english`，保证对称）；`syncPage` 同事务批量写，删篇时连带删。`df`（全库几篇含该词）不单存，查询时 `COUNT(DISTINCT path)` 现聚，代入 `IDF = ln(1 + (N-df+0.5)/(df+0.5))`。
- `dl`（篇长 = 中文二元数 + 英文词数）：`pages` 加 `doc_len INT`，`syncPage` 用 `tokenizeMixed` 输出长度随 upsert 同行写，零额外写。
- `N / avgdl`（总数/平均篇长）：新增 `corpus_stats` 单行表 `{n, avgdl, updated_at}`，`schema.sql` + `ensureSchema` 幂等，双引擎共用。
- 重算点：`compile/session.ts` 一批 note 写完（`historyEntries` 落盘处）顺手重算一次；人手单篇 `capture` 只打脏标，下次 flush 捎带；`rebuild-index`/`dream` 全量重算。
- 读写不互斥：写走 `WriteQueue` 排队，读另开连接；`corpus_stats` 单行 UPDATE 原子，读只会看到旧的完整行或新的完整行。统计天然 stale 可读——`N/avgdl` 差一点只动小数点后几位，不等刷完也能查。
- 顺序：① `doc_len + corpus_stats` 先上（半 BM25，有长度支点，`TF项 = tf*(k1+1)/(tf+k1*(1-b+b*dl/avgdl))`，`k1=1.2、b=0.75` 锁死）；② `terms` 表后上（真 IDF，等高频词作妖或另行点头）。

## 5. PGlite 原生能力分工（已实测，PGlite 0.3）

| 能力 | PG `english` | 结论 |
|---|---|---|
| 小写 | `Running`→`run` | PG 覆盖；JS 仍 lower 保 bigram/`position` 对称 |
| 词干 | `running→run`、`retries/retrying→retri` | PG 覆盖；`simple` 下 `retrying` 命中 `retries` 为 false，`english` 为 true |
| 停用词 | `THE` 丢弃 | PG 覆盖 |
| NFKC/全半角 | 全角原样留存 | JS 覆盖 |
| CJK 切分 | `重试策略` 存整串 | JS 字二元覆盖 |
| md/噪声 | 原样吃 | JS 覆盖 |

## 6. 验收

- 回归：`P131-01–04`、`M3-01/M3-06` 绿；`eval:mini` 不回退。
- 新增：`retrying→retries` 互查命中；`重试 retry` 混合查询双召回；大小写 `Retry`/`RETRY` 一致；`P13.1` 整形查询命中。
- 对称性：同一查询串摄入/检索分词输出一致（单测锁定）。
- 统计：compile 批量后 `corpus_stats` 已刷新；长文不再系统性压短文（`dl/avgdl` 支点生效）；统计刷新前后查询均可用（读旧值）。

## 7. 缺口 backlog（本次不做）

- P1：代码标识符保护（命令/路径/flag 整形保留，`stripCodeBlocks` 对 bm25 过狠）。
- P1：中文停用二元（`的是/了在`）降噪。
- P2：简繁通搜；拼音；同义词（`retry≈重试`）；拼写/模糊。
