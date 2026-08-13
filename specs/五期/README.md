# 五期 Specs — 架构补齐（非访问面）

> **前提**：三期已完成即可开工（**不依赖** MCP/REST）。  
> **分期**：当前交付主线；四期（MCP/REST）已改为 **补充期**（→ [`../四期/`](../四期/)），后置不阻塞本目录。  
> **原则**：不破坏 D1/D17/D18；能力增量；不扩 dream「夜间维护」全集（v1 五段维持现状即可）。  
> **本期产品承诺**：写入更聪明、读更省 token、检索高档可用、账本/硬删/评测/大库可选扩展。  
> **明确不做**：REST/MCP/harness（补充期）；dream 扩段；Java；多模态；分布式。

## 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P5.1 L0 提取快路径 | [`P5.1-l0-extract.md`](P5.1-l0-extract.md) | M2, P2.1a（embedding） | cosine 跳过 + 可选 LLM 抽 facts |
| 2 | P5.2 分层读写 | [`P5.2-layers.md`](P5.2-layers.md) | M2, P2.2 | abstract/overview + 按层读 |
| 3 | P5.3 检索增强 | [`P5.3-retrieval-advanced.md`](P5.3-retrieval-advanced.md) | P2.1a, P3.1 | tokenmax 真能力 + 实体层 + hotness |
| 4 | P5.4 账本与硬删 | [`P5.4-ledger-purge.md`](P5.4-ledger-purge.md) | M1, M2, P3.3 | EventLedger / linkFacts / `--purge` |
| 5 | P5.5 CLI 与 agent 范围 | [`P5.5-cli-agent-scope.md`](P5.5-cli-agent-scope.md) | P3.3；建议 P5.3 | `think`/`find`/`eval`；`agent_id` source 归属 |
| 6 | P5.6 评测体系 | [`P5.6-evals.md`](P5.6-evals.md) | P2.1a；建议 P5.3 | 公开基准适配 + hermetic 门禁（**done**） |
| 7 | P5.7 索引扩展 | [`P5.7-postgres-engine.md`](P5.7-postgres-engine.md) | M3, P2.1a | PostgresEngine / pgvector 可选后端（**done**） |
| 8 | P5.8 摄取适配器 | [`P5.8-ingest-adapters.md`](P5.8-ingest-adapters.md) | M2, P5.1（建议） | generic-jsonl + df-app fixture 可跑（**done**） |

## 技术方案总览

```
写入侧          读/检索侧           原语/运维           生态
─────────       ──────────         ──────────         ────
P5.1 提取       P5.2 分层          P5.4 ledger/purge  P5.8 ingest
   │               │                  │
   └──────► P5.3 检索增强 ◄───────────┘
                 │
            P5.5 CLI 面
                 │
            P5.6 评测门禁
                 │
            P5.7 大库后端（可选）
```

| 主题 | 落点 | 关键约束 |
|---|---|---|
| 提取 | 写队列 **之后** 异步或 sync 可选；默认 `llm.extract=off` | ADD-only；失败不回滚已写 md（D1） |
| 分层 | frontmatter 或同级 sidecar；索引可投影摘要 | 检索默认注 L0/L1；L2 按需 |
| 检索 | 扩展 `hybridQuery` / RRF 权重；rerank 可插拔 | 不可用时 fail-open 降级 balanced |
| 账本/硬删 | 文件事务 + force commit（D18）；purge 需 owner | 禁止只改索引（D13） |
| agent_id | `AuthedRequest` 扩展；source 参与表或 grant | fail-closed；与 token 叠加 |
| 评测 | `evals/` 适配器；CI 可选 job | pin commit；不默认联网 |
| Postgres | `IndexEngine` 抽象；PGLite 仍默认 | 可丢索引 + rebuild 语义不变 |
| ingest | `packages/adapters/ingest-*`；调 `capture`/`validateWrite` | 不进 core 硬编码平台 |

## 验收总则（强制）

1. **功能可开箱使用**：Spec 目标中的每一项能力，必须有对应 CLI（或文档化的一条命令）在本地可跑通；禁止「仅接口 / 仅 stub / 仅单测绿」算完成。  
2. **零 LLM 默认可演示**：依赖 LLM/云的能力，须提供 **off/启发式/fixture** 降级路径，使贡献者无 API Key 也能走完主路径；联网能力用显式 flag。  
3. **验收 = Given/When/Then + 口令**：每条验收含可复制命令；DoD 勾选前口令必须人工或 CI 跑绿。  
4. **一事一验**：目标列表中的功能点不得合并成含糊的「集成测通过」。  
5. **可观测**：开关打开后，用户能从 `--json` / `--explain` / 文件落盘 / receipt 看出该功能生效。

## 五期完成标志

P5.1–P5.8 全部验收口令绿 + DoD 勾选 → **五期完成**（访问面仍属四期补充期）。

## 分期速查

| 期 | 内容 |
|---|---|
| MVP–三期 | CLI 可写可查 + 蒸馏/图谱/结晶/多租户（已落地） |
| **五期（本目录）** | **当前**：架构剩余能力（不含访问面、不含扩 dream） |
| [`四期/`](../四期/) | **补充期**：MCP / REST / Claude Code 适配器（后置） |
