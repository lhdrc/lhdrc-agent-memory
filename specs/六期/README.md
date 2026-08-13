# 六期 Specs — 会话摄入（inbox → compile → L0）

> **前提**：五期 P5.1–P5.8 已完成（**不依赖** MCP/REST）。  
> **分期**：当前交付主线。四期（MCP/REST）仍为 **补充期**（→ [`../四期/`](../四期/)），后置于本期。  
> **来源**：原 [`../五期/P5.9-session-compile.md`](../五期/P5.9-session-compile.md) 已 **superseded**，实现以本目录为准。  
> **原则**：不破坏 D1/D17/D18；原文归档 ≠ L0 记忆；会话写入经 **compile 入口的一次 WriteQueue job**（节点是 `captureWrite`）。  
> **本期产品承诺**：会话摄入必须经 LLM `complete()` 把原文编成短记忆；无 Key 则命令失败并提示，不以启发式冒充。人手 `capture` / BM25 `query` 仍可零 LLM。  
> **主线状态**：P6.1–P6.4 + P6.5 门控 **done**。Cursor 模板（P6.5 §4）仍为增强轨。  
> **主线补丁**：[`P6.6-extract-contract.md`](P6.6-extract-contract.md) **done**（类型合同 + prefetch；学 OV 说明书思路，不抄 11 类 / ReAct）。  
> **明确不做**：MCP/REST（四期）；Idle TTL / token 阈值 / PreCompact；11 类记忆；自动 `entity create`；扩 dream；用 LLM 判断「该不该查」。

## 架构选择（已锁定）

| # | 选择 | 含义 |
|---|---|---|
| 1 | 编译器在记忆系统内 | CLI 只是运输；core 持规则（prompt/schema）；经 LLM API `complete()` 调模型 |
| 2 | 先归档，后提取 | 原文写入 `.dfmemory/inbox/`（不进 git、不进检索），再 compile；LLM 失败只丢结构化层 |
| 3 | 摄入入口是 compile，不是 capture | `remember` / `ingest --adapter session` → `compileSession`。单写队列挂在**这一入口**（一次 job）。`capture` 只是 pipeline 里的写盘节点 |
| 4 | 会话路径默认去重 | `compile.dedupe_cosine` 默认 0.95；embedding off 时仍做全等去重 |
| 5 | 会话产品必须 LLM API | `remember` / session ingest 无模型则 `E_DISABLED`；测试 mock；init 默认 provider 仍为 off |
| 6 | 查询门控不调 LLM | 学 OV 分层，但用词表+打分（阈值 3）；命中才 `think`/`find` |

```
CLI remember / ingest session / --retry     ← 摄入入口
        │
        ▼
compileSession
        │  archive inbox（锁外）
        │  extract（必须 complete；剥 df-memory-context）→ 去重 → linkify
        │  写 extracted.json 检查点
        ▼
WriteQueue.execute  **一次**                  ← 单写队列在入口
        │  captureWrite × N（pipeline 节点：只写 md）
        │  索引 hook + dirty + flush（队列原语义）
        ▼
brains/{id}/sources/ … L0
```

`memory capture` 仍给人写**已经合法**的节点（M2）；内部等价「单节点 pipeline」：自己 `execute(() => captureWrite)`。P5.8 逐行 ingest 不变。会话摄入**禁止**再对每条候选嵌套 `captureNode`→`execute`。

词表：用 **archive / compile / ingest**，不要把本期流程叫 git `commit`（D18）。

## 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 |
|---|---|---|---|---|
| 1 | P6.1 LLM complete API | [`P6.1-llm-complete.md`](P6.1-llm-complete.md) | 现有 `LLMProvider` 桩 | 通用 `complete()`；openai 真打；off=noop |
| 2 | P6.2 Inbox | [`P6.2-inbox.md`](P6.2-inbox.md) | M1 | `.dfmemory/inbox/`；pending/done/failed；不进检索 |
| 3 | P6.3 Session compile | [`P6.3-session-compile.md`](P6.3-session-compile.md) | P6.1, P6.2, P5.1, P3.1 | prompt+逻辑；必须 complete |
| 4 | P6.4 CLI | [`P6.4-cli-remember.md`](P6.4-cli-remember.md) | P6.3, P5.8 | `remember` / `ingest session` / `--retry` |
| 5 | P6.5 查询门控 | [`P6.5-harness.md`](P6.5-harness.md) | P5.5 | **主线**：`shouldQueryMemory` 打分；模板为增强轨 |
| 6 | P6.6 提取合同 | [`P6.6-extract-contract.md`](P6.6-extract-contract.md) | P6.3 | **主线补丁**：三类型说明书、prefetch 已有标题、`source_turns`、一次 JSON 修复 |

主线 = P6.1–P6.4 + P6.5 门控函数。Cursor 模板不阻塞「六期主线完成」。P6.6 不改类型清单，只加厚提取 prompt。F11/F12 **本期不做**。

## 与五期 / 四期边界

| Spec | 关系 |
|---|---|
| P5.1 | 事后 enrich 仍服务人手 `capture`；会话路径走 `captureWrite`，**无**写后 extract |
| P5.8 | `generic-jsonl` / `df-app` 不变；`session` **不**走逐行 `ingestJsonl.map` |
| P3.1 | 不改抽链；编译器插入 `@slug` |
| P2.2 | 蒸馏仍只写 `experiences/` |
| P4.1 | 换运输（CLI→MCP）；inbox/compile/触发表不变；`memory_remember` 应收**原文** |

## 验收总则

功能可开箱、GWT+口令、一事一验、`--json` 可观测。  
**会话摄入**：CI 用 **mock `complete`**，不把 `provider=off` 启发式当演示。无 Key 的正确行为是 `E_DISABLED`。人手 `capture`/`query` 仍零 LLM 可跑。

## 六期完成标志

P6.1–P6.4 口令全绿 + P6.5 门控单测（P65-01–08）→ **六期主线完成**。P6.6 提取合同（P66-01–08）为补丁，已落地。Cursor 模板为增强轨。访问面仍属四期。
