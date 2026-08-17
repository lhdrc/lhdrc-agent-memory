# 九期 Specs — 检索量纲 + 写入合同

> **前提**：八期主线 **P8.2–P8.5 done**；P8.1 测例全绿（仅 P81-17 真机 `next` 关账，**不进本期 DoD**）。  
> **来源**：[`TODO.md`](../../TODO.md) 九期表（2026-08-16 会话锁定）。  
> **原则**：不破坏 D1/D14/D17/D18；与 08 冲突时 **先改本目录 Spec + 08 ADR，再改代码**。无 facts / event_ledger 索引表（#16 不做）。  
> **本期产品承诺**：索引 hash 幂等；embedding 三档（默认 API）；融合分能量纲对齐；低分过滤默认开；写入默认不阻塞；facts 可带量纲并查趋势；启动注入经验；skill 可回写 outcome。  
> **明确不做（本期）**：MCP/REST；多宿主 harness；npm publish；query LLM 扩写；compiled_truth；facts 表；dream 九段；pgvector HNSW（下期 #9）；图谱扩词表（下期 #8）。

## 0. 对 TODO 九期表的拆分（已锁定）

12 条不能各开一张 Spec。检索三项共用一条管线；agent 两项共用插件注入面。

| TODO | 评估 | 九期去向 |
|---|---|---|
| **#14 content_hash** | 真 bug：时间戳进 hash → 每次 capture 重切块。无依赖。 | **P9.1** |
| **#13 embedding 三档** | 改 ADR：默认从离线哈希改为 `openai`；CI 仍钉 `local`。 | **P9.2** |
| **#21 rescale + hotness 乘法** | 与 #10/#11 同一 `hybridQuery` 尾段。sigmoid / min-max / 改 k=60 **不做**。α **可配、默认 0.15**（禁止沿用加法 0.45）。 | **P9.3** |
| **#10 过滤 + rerank** | 过滤默认开；真 rerank 默认关。 | **P9.3** |
| **#11 cosine re-score** | embedding 可用即跑（含哈希）；`off` 跳过。 | **P9.3** |
| **#15 source 7 层** | CLI/core 解析，与检索无关。 | **P9.4** |
| **#12 趋势** | 先改 WRITE_FORMAT；无 facts 表则扫 md。 | **P9.5** |
| **#19 outcome 回写** | core 已有 `applySkillOutcome`；缺注入后的工具/挂钩。不自动 active。 | **P9.6** |
| **#25 启动注经验** | 插件 session-start；skill 仍 P8.3。 | **P9.6** |
| **#27 Iron Law** | 写后 enrich，不扩 dream。 | **P9.7** |
| **#41 写路径默认异步** | 废止八期「CLI remember 默认同步」。JobRunner **迁入 core**。 | **P9.8** |
| **#42 merge_op** | 只驱动蒸馏/经验合并；L0 仍 ADD-only。 | **P9.9** |

### 0.1 必须遵守的裁剪

1. **k=60 不动**；不做 Mem0 sigmoid、不做各臂 min-max。  
2. **不建** `facts` / `event_ledger` 表；#12 扫文件。  
3. **不自动** `skill activate`（守 P7.2 / P8.3）。  
4. **不**系统级级联检索；启动只注经验，不注 L0、不注 skill。  
5. **不**扩 dream 九段；back-link 走写后 enrich。  
6. **不**改 L0 ADD-only；`merge_op` 不驱动 `updateNode`。  
7. 下期项（#8/#9/#17/…）**禁止**顺手做。  
8. P81-17 真机补验属八期关账，不挡九期编码。

## 1. 产品承诺

```
init 新仓          → embedding.provider: openai（无 Key 时语义臂 fail-open 哈希）
capture / remember → 默认入队；--wait 才同步写完
query              → RRF×(k+1) 融合 → 低分过滤 → cosine re-score → hotness 乘法
session-start      → 注入成熟经验 top-3（失败 fail-open）
skill 用过         → memory_skill_outcome 回写 eta/support；升格仍人手 activate
facts 带量纲       → memory trend 能答「是否在恶化」
```

## 2. 架构选择（已锁定）

| # | 选择 | 含义 |
|---|---|---|
| 1 | hash 白名单 | 只吃语义字段；时间戳不进 `content_hash` |
| 2 | embedding 默认 API | `openai` 默认；`onnx` 真本地模型；`local` 仍为哈希。`off` 杀语义臂（第四档，已有） |
| 3 | 融合 rescale | `rrf' = rrf * (k+1)`；hotness `score = final_rel * (1+α*hotness)` |
| 4 | JobRunner 在 core | CLI 与插件共用 `.dfmemory/jobs/`；禁止两套队列 |
| 5 | CLI 默认异步 | `capture` / `remember` / `compileSession` 入队；`--wait` 兼容旧口令 |
| 6 | 趋势扫 md | 不预建 facts 表 |
| 7 | 经验 = 理解层 | 不建 compiled_truth；实体页仍是身份卡 |

## 3. 实现顺序

| 顺序 | Spec | 文件 | 依赖 | 一句话 | 主线 |
|---|---|---|---|---|---|
| 1 | P9.1 hash | [`P9.1-content-hash.md`](P9.1-content-hash.md) | M3 | 语义 hash；时间戳不变不重嵌 | **是** |
| 2 | P9.2 embedding | [`P9.2-embedding-providers.md`](P9.2-embedding-providers.md) | P5.7、P9.1 | 三档；默认 openai；CI 用 local | **是** |
| 3 | P9.3 融合 | [`P9.3-fusion-rescore.md`](P9.3-fusion-rescore.md) | P2.1a、P8.2、P9.2 | rescale、floor、cosine、rerank 关、hotness 乘法 | **是** |
| 4 | P9.4 source | [`P9.4-source-resolve.md`](P9.4-source-resolve.md) | M1 | 7 层解析 | 否 |
| 5 | P9.5 趋势 | [`P9.5-temporal-facts.md`](P9.5-temporal-facts.md) | WRITE_FORMAT | metric 字段 + trend 查询 | 否 |
| 6 | P9.6 agent | [`P9.6-outcome-boot-inject.md`](P9.6-outcome-boot-inject.md) | P8.1、P8.3、P3.2 | outcome 工具 + 启动注经验 | 否 |
| 7 | P9.7 Iron Law | [`P9.7-iron-law.md`](P9.7-iron-law.md) | P7.4 | back-link + `[Source:]` | 否 |
| 8 | P9.8 异步写 | [`P9.8-async-write.md`](P9.8-async-write.md) | P8.1 | JobRunner 入 core；CLI 默认入队 | **是** |
| 9 | P9.9 merge_op | [`P9.9-merge-op-distill.md`](P9.9-merge-op-distill.md) | P2.2 | 蒸馏读 pack merge_op | 否 |

主线 = **P9.1 → P9.2 → P9.3** 与 **P9.8**（写入 UX）。P9.4/P9.5/P9.7/P9.9 可与主线并行。P9.6 主在插件仓。

P9.3 的 cosine 在 P9.2 前也能跑（哈希档）；但测例分「哈希拉开有限 / API mock 拉开」。

## 3.1 进度（2026-08-17）

| Spec | 状态 | 备注 |
|---|---|---|
| P9.1 hash | **done** | 已 commit |
| P9.2 embedding | **done** | 已 commit |
| P9.3 融合 | **done** | 已 commit |
| P9.4 source | **done** | 已 commit |
| P9.5 趋势 | **done** | 已 commit |
| P9.6 agent | **done** | 本仓 helper + 插件 `memory_skill_outcome`/boot inject |
| P9.7 Iron Law | **done** | 已 commit |
| P9.8 异步写 | **done** | JobRunner 在 core；CLI 默认入队 |
| P9.9 merge_op | **done** | 已 commit |

关账顺序：九期主线已关。

## 4. 仓库边界

| 改动 | 仓库 |
|---|---|
| hash / embed / rrf / hotness / WRITE_FORMAT / source 解析 / JobRunner / merge_op / back-link | 本仓 `packages/core` + CLI |
| 启动注入、skill_outcome 工具、prompt | 并列仓 `dsh-df-memory/` |
| npm publish / MCP / 多宿主 | **不改** |

## 5. 不进本期的项

见 [`TODO.md`](../../TODO.md) 文首 **下期** 表与「明确不做」。尤其：#8 图规则、#9 pgvector、#17 矛盾（开工前再问）、#36 publish。

## 6. 验收总则

- Given/When/Then 一事一验；`bun test packages/core/tests/`。  
- 默认 `openai` **不得**让 hermetic CI 出网：测例显式 `provider: local` 或 mock。  
- 无 Key：语义臂 fail-open 哈希；compile 仍 `E_DISABLED`（不写 L0）。  
- 异步失败不留半成品 md。  
- 插件测例 mock `ctx`；本仓 CI 不强制起 DSH。

## 九期完成标志

P9.1–P9.9 DoD 勾选 → **九期完成**。
