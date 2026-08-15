# dsh-df-memory TODO（2026-08-15 会话评审）

> 七项改进评估记录。**已收成八期 Spec**（2026-08-15）：见 [`specs/八期/README.md`](specs/八期/README.md)。  
> 原则：先改 Spec/文档再改代码。实现以八期为准，本文件不再当执行清单。

## 优先级总览 → 八期映射

| # | 事项 | 评估 | 八期 |
|---|---|---|---|
| 1 | inbox 会话挂钩 | 合理（= 原 P4.2 B） | **P8.1**（B 从四期迁入） |
| 2 | memory_remember 后台异步化 | 合理；与 #1 共用 job | **P8.1** |
| 3 | 自定义 brain（per-call） | 部分合理 | **P8.5**（不阻塞主线） |
| 4 | 抽取 prompt 优化 | 合理；只改 core 合同 | **P8.4** |
| 5 | 懒蒸馏阈值 5 → 3 | 仓配置即可；改默认后置 | **不做 Spec** |
| 6 | 分层检索建议 | 合理；不做级联 | **P8.2** |
| 7 | Skill 独立抽取 + 注入 | 合理；「抽取」改为查找+注入 | **P8.3** |

裁剪与锁定决策见八期 README §0。下列原文保留作评审痕迹，**与 Spec 冲突时以 Spec 为准**。

---

## 1. inbox 会话挂钩（P4.2 B 档）

**理想范式**（用户确认）：
```
session-start        → 打开 inbox session（或惰性）
每轮 user/assistant  → appendSessionTurns（只存文本轮）
窗口满               → compileSession（flush 到记忆）
会话结束             → endSession（自动 flush 剩余）
```

**现状**：`memory_remember` 每次调用 = 一次独立 `compileSession`（新 inbox session），不是"追加-攒批"范式。

**评估**：合理且可行。core 已就绪：`compile/window.ts`（`appendSessionTurns`/`endSession`）、`retrieve/query-triggers.ts`（`shouldQueryMemory`，B 档注入用）。缺的是适配层挂钩。

**TODO**：→ [`specs/八期/P8.1-session-hook-async.md`](specs/八期/P8.1-session-hook-async.md)

**风险**：fail-open 原则——任何挂钩失败不得把 transcript 写入 sources/；失败可观测。

## 2. memory_remember 后台异步化

**现状**：工具执行 = 同步 compileSession（LLM 抽取 + 写盘 + 可能懒蒸馏），实测单次可达 15-18s，阻塞主会话。

**评估**：合理，但**不能 fire-and-forget**。与 #1 共用 JobRunner（`.dfmemory/jobs/`）。

**TODO**：→ P8.1 §4.2–4.5

## 3. 自定义 brain 支持

**现状**：`config.brainId` 覆盖 + `memory_brain create/list` 可用；工具无 per-call brain 参数。

**评估**：部分合理。会话级切换不做。

**TODO**：→ [`specs/八期/P8.5-tool-brain.md`](specs/八期/P8.5-tool-brain.md)

## 4. 抽取 prompt 优化（note 拆太细）

**现状**：compile 抽取粒度由 core `resources/session-extract-v1.md` 决定。

**评估**：合理。只改 core 合同；插件预处理是非目标。P6.6 不得破坏。

**TODO**：→ [`specs/八期/P8.4-extract-granularity.md`](specs/八期/P8.4-extract-granularity.md)

## 5. 懒蒸馏阈值 5 → 3

**现状**：`distill.lazy_min_sources` 默认 5，**已是每仓可配置项**。

**评估**：仓内先配 `distill.lazy_min_sources: 3`。改 core 默认值等 P8.1 异步落地后再开补丁。

## 6. 分层检索建议（全量检索保 recall，分层提 precision）

**骨架（保持不动）**：混层并行召回（三臂 RRF）+ 模型按需回读原文。任何分层不得牺牲 recall。不做系统级级联。

**TODO**：→ [`specs/八期/P8.2-layered-retrieve.md`](specs/八期/P8.2-layered-retrieve.md)

## 7. Skill 层独立抽取 + 按需查找注入

**纠正**：不是会话抽 SKILL.md。skill 仍经 P3.2/P7.2 结晶。本期是查找面 + 注入面，默认 query 剥离 skill。

**TODO**：→ [`specs/八期/P8.3-skill-inject.md`](specs/八期/P8.3-skill-inject.md)

---

## 备注

- 本会话相关既有结论：核心探索报告见 `reports/12-核心与适配层探索结论.md`（事件账本缺 node_created、B 档未接、init --git existing 风险等）
- 所有涉及 core 的改动须先改 Spec 再改代码（AGENTS.md 硬约束）
