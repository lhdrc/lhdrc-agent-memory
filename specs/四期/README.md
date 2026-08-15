# 四期 Specs — 补充期（访问面）

> **定位**：**补充期**——不阻塞五/六/七期。  
> **前提**：三期已完成；实现排在七期主线之后（或用户点名再做）。  
> **原则**：agent 访问面绑定已稳定的检索/蒸馏/会话编译契约。  
> **本期产品承诺（P4.1）**：MCP + REST 子集 + 至少一个 agent 适配器——**仍后置**，未获要求不实现。  
> **本期已点名（P4.2）**：[插件化](P4.2-插件化.md)——DeepSeek Harness Cordis 插件；**不**经 MCP。agent **不**把直接读仓文件当主 API。

## 实现顺序

| 顺序 | Spec | 文件 | 状态 | 依赖 |
|---|---|---|---|---|
| 1 | P4.2 插件化 | [`P4.2-插件化.md`](P4.2-插件化.md) | **in_progress**（A 档） | M3、P2.1a、P3.3、P5.2、P6.3 |
| 2 | P4.1 MCP/REST/适配器 | [`P4.1-mcp-rest-adapters.md`](P4.1-mcp-rest-adapters.md) | draft（后置） | M2, P2.1a；建议 P2.2、P3.3 |

P4.2 **不依赖** P4.1。插件在**独立 git 仓**，本仓只做 core 的 Node 兼容与 npm 分发。

## 新增包（建议）

```
# P4.2：独立仓 dsh-df-memory（依赖 npm @lhdrc/core）
# P4.1（后置）：
packages/mcp/
packages/adapters/claude-code/
packages/server/          # REST 可选与 cli 同进程
```

## 完成标志

P4.2 A 档 DoD 勾选 → DSH 工具访问面可用（query/read/remember）。  
P4.1 DoD 勾选后，MCP/REST 访问面交付完成。架构侧见 [`../五期/`](../五期/)；会话摄入见 [`../六期/`](../六期/)；LLM 真路径见 [`../七期/`](../七期/)。
