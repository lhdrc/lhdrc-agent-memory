# 二期 Specs

> **前提**：MVP（M1–M3）已完成且验收口令全绿。  
> **原则**：不破坏文件权威与 D17；只增加能力。

## 实现顺序

| 顺序 | Spec | 文件 | 依赖 |
|---|---|---|---|
| 1 | P2.1a 混合检索 | [`P2.1a-hybrid-retrieval.md`](P2.1a-hybrid-retrieval.md) | M3 |
| 2 | P2.1b 图谱与信号 | [`P2.1b-graph-signals.md`](P2.1b-graph-signals.md) | P2.1a |
| 3 | P2.2 蒸馏与分层 | [`P2.2-distill-layers.md`](P2.2-distill-layers.md) | M3, P2.1a |
| 4 | P2.3 MCP/REST/适配器 | [`P2.3-mcp-rest-adapters.md`](P2.3-mcp-rest-adapters.md) | M2, P2.1a |
| 5 | P2.4 结晶与 dream | [`P2.4-crystallize-dream.md`](P2.4-crystallize-dream.md) | P2.2 |
| 6 | P2.5 多租户 | [`P2.5-multitenant.md`](P2.5-multitenant.md) | M2, P2.1a |

## 二期新增包（建议）

```
packages/mcp/
packages/adapters/claude-code/
packages/server/          # REST 可选与 cli 同进程
```
