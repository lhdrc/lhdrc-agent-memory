# 十期 Specs — LoCoMo 发数评测

> **前提**：九期 **P9.1–P9.9 done**。P5.6 hermetic 门禁（`eval:mini` / `eval:distill` / locomo **fixture**）保持，不进本期改语义。  
> **来源**：2026-08-18 会话锁定——**只做 LoCoMo**，要对外发数；LongMemEval / HaluMem **不做**（TODO #35 其余项仍下期再问）。  
> **原则**：公开数字走 CLI `evals/` 直调 core；**不**用 DSH 插件刷分。写入必须 `compileSession`，禁止 transcript dump。CI 默认无网。  
> **本期产品承诺**：能按业界 J-score 协议跑全量 `locomo10.json`，receipt 含准确率 / token / 延迟 / pin，数字可写进报告。

## 0. 拆分

| 项 | 去向 |
|---|---|
| LoCoMo 发数协议 + 评测前检查单 + runner | **P10.1** |
| LongMemEval_S / HaluMem | **不做**（仍 TODO #35） |
| 把 `eval` 做成 DSH 工具 | **不做**（P4.2 非目标） |
| 改 `eval:mini` / locomo `--fixture` 子串口径 | **不做**（P5.6 门禁） |

## 1. 实现顺序

评测前检查单（P10.1 §4）必须按 G0→G6 过完，才允许全量跑、才允许把数字写进 README / 对外稿。G0 是代码交付；G1–G6 是发数前操作门闩。

## 2. 仓库边界

| 改动 | 仓库 |
|---|---|
| adapter / publish runner / prompts / receipt | 本仓 `evals/` + CLI `memory eval` |
| 评测仓 `memory.yml` 覆盖（openai + 关蒸馏） | 评测脚本写临时仓，不改用户仓默认 |
| DSH 插件 | **不改** |

## 3. 进度

| Spec | 状态 |
|---|---|
| P10.1 LoCoMo 发数 | **in_progress**（G0 runner + P101 测例绿；全量发数待 G1–G6） |
