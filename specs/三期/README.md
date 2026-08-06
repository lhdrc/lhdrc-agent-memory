# 三期 Specs

> **前提**：二期（P2.1a + P2.2）DoD 勾选完成。  
> **原则**：不破坏 D1 / D17 / D18；飞轮深化与单机多租户仍以 **CLI** 为主。  
> **本期产品承诺**：图谱调权 + Skill 结晶 / dream + 多租户隔离。  
> **不做**：MCP / REST / harness 适配器（→ [`../四期/`](../四期/)）。

## 实现顺序

| 顺序 | Spec | 文件 | 原 ID | 依赖 |
|---|---|---|---|---|
| 1 | P3.1 图谱与信号 | [`P3.1-graph-signals.md`](P3.1-graph-signals.md) | P2.1b | P2.1a |
| 2 | P3.2 结晶与 dream | [`P3.2-crystallize-dream.md`](P3.2-crystallize-dream.md) | P2.4 | P2.2 |
| 3 | P3.3 多租户 | [`P3.3-multitenant.md`](P3.3-multitenant.md) | P2.5 | M2, P2.1a |

## 三期完成标志

P3.1–P3.3 DoD 全部勾选后，视为三期完成；其后进入 [`../四期/`](../四期/)（MCP/REST）。

> 注：P3.3 的 `AccessControl` 应在 CLI 与后续 P4.1 共用；四期挂载工具面时直接复用，避免鉴权重写。
