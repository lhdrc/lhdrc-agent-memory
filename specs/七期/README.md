# 七期 Specs — LLM 真路径 + 图补齐

> **前提**：六期主线已完成（P6.1–P6.4 + P6.5 门控 + P6.6）。**不依赖** MCP/REST。  
> **分期**：当前交付主线。四期（MCP/REST）仍为 **补充期**。P6.5 Cursor 模板 **本期不做**。  
> **来源**：[`AGENTS.md`](../../AGENTS.md) CLI 审计 backlog（2026-08）；六期所称 F11/F12（滑动窗口、compile 自动建 entity）。  
> **原则**：不破坏 D1/D17/D18；`complete()` 仍是唯一补全入口；`provider=off` 不以启发式冒充会话编译或蒸馏产品。  
> **本期产品承诺**：配好 `llm.provider=openai` + key 后，`refine` / dream 3 / skill 结晶 / `capture --extract` / `layers refresh` **真打模型**；会话可按窗口攒 turns 再 compile；compile 成功后未蒸 L0 够数则懒蒸馏，成熟则自动结晶 **candidate** skill；compile/capture 统一挂链，模型可建 entity；普通 `query` 能用邻接。  
> **明确不做**：MCP/REST（四期）；P6.5 Cursor 模板；Idle TTL / PreCompact / 守护进程；扩 dream 九段；11 类记忆；新 schema pack；把 `remember` 默认改成启发式（无 Key 仍 `E_DISABLED`）；**agent 每轮自动把对话推进 inbox**（API 七期有，接入层以后再说）。

## 写入时机（本期冻结）

| 层 | 何时写 | 谁写 |
|---|---|---|
| L0 issue/note/decision/lesson | 人手 `capture`；会话 `compileSession` → `captureWrite`（一场一次 WriteQueue） | 路径仍由 schema pack |
| experience | compile **放锁后**未蒸 L0 ≥ `lazy_min_sources` 则懒蒸馏；也可 `refine` / `dream --phases 3` | P7.2；**不**在 compile 那把锁里蒸 |
| skill | 上述蒸馏之后，成熟簇自动写 **candidate**（不 activate）；也可人手 `skill crystallize` | P7.2；公式仍 P3.2 |
| entity + links | compile 时模型可提议 entity，与 L0 同一 job 写文件并 linkify；索引 hook 抽边 | P7.4；capture 只挂已有 |
| agent | **只做 ACL**，不写记忆节点 | 不变 |

## 从 backlog 进来 / 不进来

| backlog | 去向 |
|---|---|
| P0 refine 真逻辑 | **P7.2**（依赖 P7.1） |
| P0 OpenAI LLM 仅 complete | **P7.1** |
| P0 滑动窗口摄入 | **P7.3**（六期 F11） |
| P0 图：AI 建 entity + 统一建边 | **P7.4**（六期 F12） |
| P1 capture `--extract` LLM 未接 | **P7.1**（`extractFacts` 走 `complete`） |
| P1 layers 仅启发式 | **P7.1**（`layers refresh` 在 openai 时调 `generateAbstract`） |
| P1 eval `--distill` 不测 refine | **P7.2** |
| P1 各层写入时机 | 本 README 表；experience/skill → P7.2；entity → P7.4 |
| P1 revert 范围窄 | **P7.5** |
| P1 graph-query fail-open 像「无记忆」 | **P7.4** |
| P2 inbox 仅 list | **P7.5** |
| P2 EnvMock 只 mock `complete` | **P7.1** |
| P2 skill 结晶 LLM 静默降级 | **P7.2** |
| （产品）自动结晶 skill | **P7.2**：蒸馏后成熟 → candidate，不 activate |
| （产品）agent 每轮进 inbox | **以后再说**：P7.3 只提供 `--buffer`；不接 Cursor/agent 每轮自动 append |
| P2 changes 多为 refine noop | **P7.2** 真 judge 后自然消失；noop 仅当模型判 skip |
| P1 remember / session 默认 `E_DISABLED` | **不做**：六期产品承诺；escape 仍是 `remember --no-extract` |
| P1 embedding `off` 关语义臂 | **不做**：用户显式关 |
| P1 schema use 仅 problem-tree | **不做**（MVP 范围） |
| P1 embedding/git 默认、RRF 系数 | **不做新 Spec**：代码已改，跟提交走 |
| P2 import 默认不 enrich | **不做**：P5.1 默认 `extract=false` |
| P6.5 Cursor 模板 | **不做** |

## 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P7.1 LLM complete 全覆盖 | [`P7.1-llm-complete-coverage.md`](P7.1-llm-complete-coverage.md) | P6.1、P2.2、P5.1、P5.2 | **done**：既有 LLM 方法全部经 `complete()`；EnvMock 按 purpose |
| 2 | P7.2 Distill 真路径 | [`P7.2-distill-live.md`](P7.2-distill-live.md) | P7.1、P2.2、P3.2、P5.6 | **done**：refine / 编译后懒蒸 / 自动 candidate skill / eval:distill |
| 3 | P7.3 滑动窗口摄入 | [`P7.3-sliding-window.md`](P7.3-sliding-window.md) | P6.2、P6.3、P6.4 | **done**：攒 turns，达上限或会话结束再 compile |
| 4 | P7.4 图与实体 | [`P7.4-entity-graph.md`](P7.4-entity-graph.md) | P3.1、P6.3、P6.6、P7.1 | 自动建 entity、统一 linkify、query 邻接 |
| 5 | P7.5 CLI 补齐 | [`P7.5-cli-ops.md`](P7.5-cli-ops.md) | P6.2、P2.2、P3.2 | `inbox retry`；revert merge/skill/noop |

主线 = P7.1–P7.4。P7.5 不阻塞主线完成，但建议同迭代做完。

## 架构选择（已锁定）

| # | 选择 | 含义 |
|---|---|---|
| 1 | 不新开第二套 LLM API | `judgeDistill` / `refineExperience` / `generateAbstract` / `generateOverview` / `extractFacts` 都是 `complete()` 的薄封装 |
| 2 | off 路径语义不变 | 会话 compile 仍 `E_DISABLED`；蒸馏 skip；extract/layers 仍启发式 |
| 3 | 窗口不是守护进程 | 只在 CLI/API 调用时 append/flush；无 Idle TTL |
| 4 | 自动建 entity 仅会话 compile | 人手 `capture` 只对**已有** entity linkify，不调模型建实体 |
| 5 | 邻接进 hybrid，不只进 `graph-query` | 非关系句 `query` 也能用 links BFS；`graph-query` 非模板不再假装「查过无结果」 |
| 6 | compile 与蒸馏不同锁 | `remember` 落盘仍单写者、一场一次 execute；LLM/inbox 不持锁；懒蒸馏在放锁后 |
| 7 | 自动 skill 只到 candidate | 成熟才写 SKILL.md；activate 仍人工 |

## 以后再说（先记下，七期不做）

| 项 | 含义 |
|---|---|
| **agent 每轮对话进 inbox** | 产品要每轮 `appendSessionTurns`。七期只交付 CLI `remember --buffer`。不接 Cursor/MCP/对话运行时。备忘：[`doc.md`](../../doc.md) |

## 验收总则

功能可开箱、GWT+口令、一事一验、`--json` 可观测。  
LLM 路径：CI 用 **mock `complete`**（含 purpose 覆盖）；无 Key 的正确行为按层：compile/refine → `E_DISABLED` 或 skip 提示；extract/layers → 启发式。

## 七期完成标志

P7.1–P7.4 口令全绿 → **七期主线完成**。P7.5 口令绿 → 同期收口。访问面仍属四期。Cursor 模板仍不做。
