# 八期 Specs — Agent 记忆闭环（DSH 产品化）

> **前提**：七期主线 **done**（P7.1–P7.5）；P4.2 **A 档**已接线（三工具 + section；未 npm publish 不阻塞本期）。  
> **来源**：[`TODO.md`](../../TODO.md)（2026-08-15 会话评审七项）。  
> **原则**：不破坏 D1/D14/D17/D18；写入仍只经 core（`appendSessionTurns` / `compileSession` / `WriteQueue`）；插件不复制写路径。无 Key 仍 `E_DISABLED`，不以启发式冒充 compile。  
> **本期产品承诺**：DSH 会话按窗口自动进 inbox 并异步 compile；`memory_remember` 不阻塞主会话；知识检索带层标注与溯源；skill 从通用检索剥离，按需查找后注入。  
> **明确不做**：P4.1 MCP/REST；P6.5 Cursor 模板；改 DSH 源码；新 schema pack；自动 `skill activate`；会话路径直接抽 SKILL.md；系统级强制级联检索；改 `remember` CLI 默认同步语义。

## 0. 对 TODO.md 的评估（已锁定）

七项**方向合理**，但不能原样当一期 backlog。问题是：层混在一起、#1 已有规格、#5 不够成 Spec、#7 标题「独立抽取」会误导成新提取管线。

| TODO | 评估 | 八期去向 |
|---|---|---|
| **#1 inbox 挂钩** | 合理，且 **= P4.2 B 档**（§9 已写、A 不实现）。core `appendSessionTurns` / `endSession` / `shouldQueryMemory` 已就绪。 | **P8.1**（承接 B，不再在四期实现） |
| **#2 remember 异步** | 合理，且是当前最大 UX 痛点。不能 fire-and-forget。必须与 #1 **共用一套任务机制**（挂钩 flush 慢、append 快）。 | **P8.1**（同一 Spec，禁止两套队列） |
| **#3 per-call brain** | 部分合理。`config.brainId` + CLI `--brain` 已有；缺的是工具参数。会话级切换不值得做。 | **P8.5**（不阻塞主线） |
| **#4 抽取粒度** | 合理。根在 core `session-extract-v1.md`，改它 = 发版。插件预处理是假选项（会对抗 P6.6）。先用真实对话样本复测。 | **P8.4** |
| **#5 懒蒸 5→3** | 合理但不够成 Spec。已是仓配置。改 core 默认会放大 #2 延迟。 | **不做 Spec**：仓内先配；默认值改期后置到 P8.1 异步落地之后 |
| **#6 分层检索** | 合理：骨架（混层 RRF + 按需回读）不动。①标注 / ③溯源价值高；② ±0.01 tie-break 近安慰剂；④是 prompt。图臂缺 `schemaType` 是真缺口。 | **P8.2** |
| **#7 Skill 独立抽取+注入** | 方向合理，**用词不准**。skill 已由 P3.2/P7.2 结晶产生，不是会话 extract 的第四类型。「独立」指**查找面 + 注入面**与知识检索分离，不是再做一条 session→SKILL.md 管线。 | **P8.3** |

### 0.1 必须遵守的裁剪

1. **P4.2 B 迁入本期**，四期 §9 改为指针。禁止在 P4.2 与 P8.1 各写一套挂钩语义。  
2. **#1 与 #2 同一任务机制**：append 同步且快；compile / `endSession` / 显式 remember 入队。  
3. **挂钩层必须过滤 `tool` / `system`**，不能依赖 `archiveSession` 截断。  
4. **#4 只改 core 提取合同**；插件侧聚合/裁剪列为非目标。  
5. **#7 不新增会话抽 skill**；不自动 `activate`。  
6. **#6 不做系统级级联**（先 experience 后 L0 只写进 prompt 策略）。  
7. **#5 改默认值不进本期 DoD**。

## 1. 产品承诺

配好仓内 LLM（或 B 档已接的 `ctx.llm` → `complete()`）后，DSH 会话应表现为：

```
session-start     → 打开（或惰性打开）inbox session
每轮 user/assistant → appendSessionTurns（同步、只存文本轮）
窗口满            → 入队 compile（异步；不堵主会话）
会话结束 / 卸载   → 入队 endSession（剩余 turns flush）
pre-step          → shouldQueryMemory；命中则检索并 inject（知识层）
模型要规则        → memory_skill find → 命中后注入（规则层，不混 query）
模型主动记        → memory_remember → accepted + task_id（可查 status）
```

失败 **fail-open**：挂钩/任务失败可观测，**不得**把 transcript 写入 `sources/`。

## 2. 架构选择（已锁定）

| # | 选择 | 含义 |
|---|---|---|
| 1 | B 档从四期迁出 | 实现与验收以 P8.1 为准；P4.2 §9 只保留指针 |
| 2 | 一套任务，两种触发 | 窗口 flush 与 `memory_remember` 共用 job；禁止 DSH jobs 与自建队列并行两套 |
| 3 | 先自建 job 文件 | `.dfmemory/jobs/` 为权威状态；`ctx.get("jobs")` 若契约匹配可适配，**不**阻塞选型 |
| 4 | CLI remember 仍同步 | **八期如此**；**九期 P9.8 废止**：CLI 默认入队，`--wait` 才同步 |
| 5 | 知识层 ≠ 规则层 | `memory_query` 默认可剥离 skill；skill 走独立查找 + 注入 |
| 6 | 标注不改召回骨架 | 三臂 RRF + 按需 `memory_read` 不动；分层只做标注/可选排除侧车/图臂 type |
| 7 | 粒度改 prompt 不改类型 | 仍只产出 `decision \| lesson \| note`；P6.6 合同（`source_turns`、禁 path/wikilink/frontmatter、JSON 修复）保持 |

## 3. 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 | 主线 |
|---|---|---|---|---|---|
| 1 | P8.1 挂钩 + 异步 | [`P8.1-session-hook-async.md`](P8.1-session-hook-async.md) | P4.2 A、P7.3、P6.3、P6.5 | 每轮 append；compile 入队；remember 返回 accepted | **是（done，2026-08-17 关账）** |
| 2 | P8.2 检索分层 | [`P8.2-layered-retrieve.md`](P8.2-layered-retrieve.md) | P2.1a、P5.3、P4.2 A | 层标注、experience 溯源、图臂 schemaType、侧车可排除 | **是** |
| 3 | P8.3 Skill 注入 | [`P8.3-skill-inject.md`](P8.3-skill-inject.md) | P3.2、P8.1（注入通道）、P8.2（可剥离） | 独立查找；按需注入；不混默认 query | **是** |
| 4 | P8.4 提取粒度 | [`P8.4-extract-granularity.md`](P8.4-extract-granularity.md) | P6.6 | note 合并同类清单；独立决策仍拆条 | **是（done）** |
| 5 | P8.5 per-call brain | [`P8.5-tool-brain.md`](P8.5-tool-brain.md) | P3.3、P4.2 A | 工具可选 `brain`；过 `assertBrainScope` | 否（**done**） |

主线 = **P8.1–P8.3**。P8.4 建议同迭代（改资源即可，但要回归 P6.6）。P8.5 不阻塞主线。

P8.2 与 P8.4 可与 P8.1 **并行**（P8.2 图臂/排除是 core；P8.4 是 prompt）。P8.3 的注入落点依赖 P8.1 调研结论（DSH skill 通道 vs 自管 section），查找面可先做。

## 4. 仓库边界

| 改动 | 仓库 |
|---|---|
| `excludeSchemaTypes` / 图臂 `schemaType` / 侧车过滤 / `listSkills` 增字段 | 本仓 `packages/core` |
| `session-extract-v1.md` 粒度条款 | 本仓 `packages/core/resources/` |
| 挂钩、job 队列、工具异步、skill 工具、prompt 策略 | 并列仓 `dsh-df-memory/` |
| CLI `remember` 默认同步 | **八期不改**；**九期 P9.8 废止**（默认入队，`--wait` 同步） |

涉及 core 的项必须先改本目录 Spec，再改代码（AGENTS.md）。

## 5. 不进本期的项

| 项 | 原因 |
|---|---|
| 改 `distill.lazy_min_sources` 默认 5→3 | 仓配置已够；默认值等 P8.1 后再单开补丁 |
| 插件 remember 前聚合 body | 对抗 P6.6；粒度只改提取合同 |
| 会话 compile 直接写 SKILL.md | skill 仍只经蒸馏结晶（P3.2/P7.2） |
| 自动 `skill activate` | P7.2 已锁：自动只到 candidate |
| 系统级级联检索 | 只作文案策略（P8.2 ④） |
| 会话级 brain 切换（改 config） | 无宿主 API；per-call 参数足够（P8.5） |
| P4.1 / Cursor 模板 / 改 DSH 源码 | 既有禁令 |
| `@lhdrc/core` npm publish | 仍属 P4.2 A 收口，不阻塞八期代码 DoD |

## 6. 验收总则

- 插件测例 mock `ctx`；本仓 CI **不**强制起 DSH。  
- core 回归：`bun test packages/core/tests/`。  
- compile / remember 无 Key → `E_DISABLED` 或任务 `failed` + 该码；**不写 L0**。  
- 挂钩失败 fail-open：inbox 可 `failed`，`sources/` 无新文件。  
- Given/When/Then 一事一验。

## 八期完成标志

P8.1–P8.3 DoD 勾选 → **八期主线完成（2026-08-17：P81-17 真机 `next` 当步生效已验，八期关账）**。**P8.4 / P8.5 done**。P4.1 仍后置。
