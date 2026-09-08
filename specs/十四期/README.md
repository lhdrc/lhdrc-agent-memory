# 十四期 Specs — 中英分词 + BM25 半真实打分 + 简单 chunk + HNSW + rerank

> **前提**：十三期 **P13.1–P13.5 done**。
> **来源**：[`docs/superpowers/specs/2026-09-07-mixed-zh-en-tokenize-design.md`](../../docs/superpowers/specs/2026-09-07-mixed-zh-en-tokenize-design.md)（文本处理 + BM25 统计）+ [`2026-09-07-vector-retrieval-design.md`](../../docs/superpowers/specs/2026-09-07-vector-retrieval-design.md)（向量路：不对称/HNSW/reranker/chunk，ragent chunk 参考实现对照）。
> **原则**：不破坏 D1/D14/D17/D18；文件真相 + 索引可重建；与 08 冲突时先改本目录 + 08 ADR 再改代码；无 Key / 无权重一律 fail-open，链路不炸。
> **明确不做（本期）**：`terms` 词项表真 IDF（P14.2 阶段二，另排）；IVF；量化/Matryoshka；查询改写/HyDE；简繁/拼音/同义词/模糊；cross-encoder 装权重与 API/LLM rerank（仅占插槽）。

## 1. 产品承诺

```
文本  → 中英分流：中文二元 + 英文 english 词干，摄入检索对称
打分  → 半 BM25：doc_len + corpus_stats 支点归一，长文不再欺负短文
切块  → 边界回溯 + overlap + 碎尾合并 + 围栏 guard，下游零改
向量  → HNSW 索引召回（PGlite 直连可用，已实测），失败回退暴力
精排  → local 加强 + 开关默认 off，cross-encoder 按 P9.2 模式占插槽
```

## 2. 实现顺序

| 顺序 | 文件 | 一句话 |
|---|---|---|
| 1 | [`P14.1-mixed-tokenize.md`](P14.1-mixed-tokenize.md) | 中英分流分词 + english 双路 + 检索对称 |
| 2 | [`P14.2-bm25-stats.md`](P14.2-bm25-stats.md) | `doc_len` + `corpus_stats` 半 BM25（`terms` 阶段二另排） |
| 3 | [`P14.3-chunk-split.md`](P14.3-chunk-split.md) | 简单 chunk：边界回溯 + overlap + 碎尾合并 + 围栏 guard |
| 4 | [`P14.4-hnsw.md`](P14.4-hnsw.md) | pgvector HNSW 索引召回 + fail-open 回退 |
| 5 | [`P14.5-rerank-local.md`](P14.5-rerank-local.md) | local 精排加强 + 开关 + cross-encoder 插槽设计 |

P14.1 → P14.2 可并行开工（不同列/不同函数）；P14.3 独立（单调用点）；P14.4 依赖 P14.3 落定后的 chunk 文本（同一次 `rebuild-index` 生效）；P14.5 全独立，纯查询时。

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| 清洗/分词/查询权重 | 本仓 `packages/core` `retrieve/clean` + 新增 `retrieve/tokenize` + `retrieve/query` + `index/sync` + `schema.sql` |
| BM25 统计 | 本仓 `index/schema.sql` + `index/engine` + `compile/session` + `retrieve/query` |
| chunk | 本仓 `index/sync`（`chunkText` 单点替换）+ 新增切分模块 |
| HNSW | 本仓 `index/schema.sql` + `index/engine`（vector 扩展）+ `retrieve/semantic` |
| rerank | 本仓 `retrieve/rerank` + `retrieve/hybrid` + `embed/types`（开关沿用） |

## 完成标志（编码）

P14.1–P14.5 DoD 勾选；`P131-01–04`、`M3-01/M3-06` 回归绿；`eval:mini` 不回退。

## 进度

| 项 | 状态 |
|---|---|
| P14.1 中英分流分词 | **todo**（P141-01–06） |
| P14.2 BM25 半真实打分 | **todo**（P142-01–04，阶段二另排） |
| P14.3 简单 chunk | **todo**（P143-01–05） |
| P14.4 HNSW | **todo**（P144-01–04） |
| P14.5 rerank local 加强 | **todo**（P145-01–03） |
