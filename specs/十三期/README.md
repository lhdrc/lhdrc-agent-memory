# 十三期 Specs — BM25 文章级 + 图闭环 + History 正排 + Prompt 重构 + 真矛盾

> **前提**：十二期 **P12.1–P12.3 done**。  
> **来源**：[`TODO.md`](../../TODO.md) #51–#55（2026-09-02 `Memory 优化.md` 5块拆解 + `gbrain`/`codex` 对照）。  
> **原则**：不破坏 D1/D14/D17/D18；文件真相 + 索引可重建；与 08 冲突时先改本目录 + 08 ADR 再改代码。  
> **明确不做（本期）**：postgres 真 `vector` + HNSW（**#9**）；全量 `O(n²)` LLM 每对判；`local` 强行 LLM。

## 0. 对 TODO 的拆分

| TODO | 去向 |
|---|---|
| **#51** BM25 文章级倒排：清洗/物化/GIN + 长度归一 + 短语 | **P13.1** |
| **#52** 图谱边类型建≡检索闭环（补 5 动词模板） | **P13.2** |
| **#53** History 底层 + note 正排 | **P13.3** |
| **#54** Prompt/模板参照 Codex 重构 | **P13.4** |
| **#55** 真矛盾标记（非 duplicate 相似） | **P13.5** |
| **#9** HNSW | **不做** |

## 1. 产品承诺

```
BM25            → GIN 物化 + 清洗去噪，文章级精排稳
图谱            → 10 种边建≡检索，who decided/invested 等可问
History         → 全量对话不进索引，note 侧车 provenance 按需回跳
Prompt          → NO-OP 门控 + 高信号 4 桶，abstract/ overview 保字面
矛盾            → 实体桶 k=5 + 0.95/0.92 + 值冲突二筛 + 批量 LLM 灰区，人审*0
```

## 2. 实现顺序

| 顺序 | 文件 | 一句话 |
|---|---|---|
| 1 | [`P13.1-bm25-article.md`](P13.1-bm25-article.md) | #51 BM25 文章级物化 |
| 2 | [`P13.2-graph-verb-complete.md`](P13.2-graph-verb-complete.md) | #52 图 5 模板补齐 |
| 3 | [`P13.3-history-provenance.md`](P13.3-history-provenance.md) | #53 History 正排 |
| 4 | [`P13.4-prompt-codex.md`](P13.4-prompt-codex.md) | #54 Prompt 重构 |
| 5 | [`P13.5-contradiction-true.md`](P13.5-contradiction-true.md) | #55 真矛盾标记 |

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| BM25 / 清洗 / GIN / 归一 | 本仓 `packages/core` `index/sync` + `retrieve/query` + `schema.sql` |
| 图模板 / 检索 | 本仓 `graph/link-extraction` + `retrieve/graph` |
| History 侧车 / read | 本仓 `inbox/session` + `write/capture` + `node/read` + CLI |
| Prompt 资源 | 本仓 `resources/session-extract-v1.md` + `abstract/overview-v1.md` |
| 矛盾 | 本仓 `dream/runner` + `contradiction/*` + `retrieve/query` 预筛 |
| #9 | **禁止** |

## 完成标志（编码）

P13.1–P13.5 DoD 勾选。不含 #9。
