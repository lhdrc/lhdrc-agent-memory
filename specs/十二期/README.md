# 十二期 Specs — 嵌入热路径 + 可运维降级

> **前提**：十一期 **P11.1–P11.7 done**。  
> **来源**：[`TODO.md`](../../TODO.md) #50（2026-08-27 GroupMemBench 后）；本期会话另收失败/降级审计与配置 CLI 方案。  
> **原则**：不破坏 D1/D14/D17/D18；与 08 冲突时先改本目录 + 08 ADR 再改代码。  
> **明确不做（本期）**：postgres 真 `vector` + HNSW（**#9**）；把评测 `query_loop` 做成 CLI 默认。

## 0. 对 TODO 的拆分

| TODO / 本期项 | 去向 |
|---|---|
| **#50** 语义臂 O(n) 热路径（PGLite 也要） | **P12.1** |
| 失败 / 降级缺陷汇总 | [`failure-degrade-audit.md`](failure-degrade-audit.md)（文档，不改行为） |
| 错误包装给宿主 agent | [`P12.2-error-envelope.md`](P12.2-error-envelope.md)（原则见 [`P12-error-to-model.md`](P12-error-to-model.md)） |
| 看/改配置 CLI + LLM 开关 + Key 提示 | [`P12.3-config-cli.md`](P12.3-config-cli.md)（方案见 [`P12-config-cli.md`](P12-config-cli.md)） |
| **#9** HNSW | **不做** |

## 1. 产品承诺

```
query 语义臂     → 打分不拉全表 text；BYTEA 用 Float32 视图
长驻进程二次 query → 可命中进程内向量缓存（一次性 CLI 无增益）
rebuild 中断     → --pending-embeddings 只填 NULL，不清 pages
兼容网关 429/5xx → embeddings 请求可重试，不整段作废
```

## 2. 实现顺序

| 顺序 | 文件 | 一句话 |
|---|---|---|
| 1 | [`P12.1-embed-hotpath.md`](P12.1-embed-hotpath.md) | #50 编码与验收 |
| 2 | [`failure-degrade-audit.md`](failure-degrade-audit.md) | 现网缺陷账本 |
| 3 | [`P12.2-error-envelope.md`](P12.2-error-envelope.md) | 宿主 agent 信封 |
| 4 | [`P12.3-config-cli.md`](P12.3-config-cli.md) | `memory config` |

## 3. 仓库边界

| 改动 | 仓库 |
|---|---|
| 语义臂 / cosine / rebuild / openai 重试 | 本仓 `packages/core` + CLI `rebuild-index` |
| DSH 插件 | **不改**；长驻进程自动吃缓存 |
| #9 schema 列类型 | **禁止** |

## 十二期完成标志（编码）

P12.1–P12.3 DoD 勾选。不含 #9。

## 进度

| 项 | 状态 |
|---|---|
| P12.1 嵌入热路径 | **done**（P121-01–08） |
| P12.2 宿主 agent 信封 | **done**（P122-01–05） |
| P12.3 `memory config` | **done**（P12C-01–07） |
| 失败/降级审计 | [`failure-degrade-audit.md`](failure-degrade-audit.md) 落盘 |
