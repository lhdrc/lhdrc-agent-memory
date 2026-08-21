# TODO — 08 对照实现的差距账本

> **出身**：2026-08-15 会话评审七项（已收成八期 Spec）。  
> **2026-08-16 全量重审**：按 [`reports/08-开源记忆模块设计方案.md`](reports/08-开源记忆模块设计方案.md) 逐章对照代码 / Spec DoD。**已落地章节不列入**。本文件 = 差距全集，不是执行排期。  
> 原则：先改 Spec/08 ADR 再改代码（AGENTS.md）。与八期 Spec 冲突时以 Spec 为准。

## 下期（2026-08-16 会话锁定）

> **九期不立这些 Spec。** 下期开工仍先改 Spec/08。本表只收「明确下期做」；后续对话追加，禁止只停在聊天里。  
> **2026-08-20**：#8 / #17-B / #22+#32 已落地 [`specs/十期/`](specs/十期/)（P10.2–P10.4 **done**）。**#9 本期不做**。#17 **锁 B**（禁止 C）。

| # | 锁定做法 |
|---|---|
| 8 | 图谱规则密度对齐。扩动词 + pack `extra_verbs`、邻接种子门控、STOPWORD/ReDoS、关系查询夹具。不做 `link_kind` / 批量 jsonb 写入 / page-type→默认边。**Spec [`P10.2`](specs/十期/P10.2-graph-verbs.md)** |
| 9 | postgres 真 `vector` + HNSW。**2026-08-20 用户：本期不做。** 不进 P10.2–P10.4 DoD |
| 17 | **B**：跨文件 cosine → 只写 `contradictions.md`；同文件启发式保留；不改 hybrid；无 LLM 三分类；`local` 哈希档跳过跨文件 cosine。**Spec [`P10.3`](specs/十期/P10.3-contradictions.md)**。C 另开 Spec |
| 20+37 | **C**：L0 capture 同一写事务内 `memory_diff` `op: create` + 事件账本 `node_created`。`changes` 能审计 L0；ledger 仍 jsonl（#16 不做表）。 |
| 22+32 | observer 补 latency + evidence 分布；`--explain` 补 `query_plan` / `searched_directories` / 分母级 `score_details`。同一套 query log。**Spec [`P10.4`](specs/十期/P10.4-query-observe.md)** |
| 29 | 敏感字段 mask。范围未锁（A 不做 / B 仅拒绝落盘 / C 拒绝或打码）。**下期开工前必须再问一次**，禁止默认按 08 打码开工。 |
| 35 | 公开 bench LongMemEval_S / HaluMem。范围未锁。**下期开工前必须再问一次**（是否上 adapter、是否进 CI、和 `eval:mini` 的关系），禁止默认按 reports/10 P0 全量开工。 |
| 34 | 开源治理面（含 `memory upgrade`）。upgrade = 升 CLI/core 包版本 + 可选 `memory.yml` 迁移，**不改** `brains/**` / AGENTS.md。**无 npm publish（#36 本次不做）则 upgrade 无对象**；下期开工前必须先问是否同时重开 #36。不含 MCP/#24 examples。 |

## 九期（2026-08-16 会话锁定）

> 先改 Spec/08 再改代码。**八期已关账（2026-08-17：P81-17 真机 `next` 当步生效已验证）**，不进九期 DoD。hotness **α 默认 0.15**（P9.3；禁止沿用加法 0.45）。规格：[`specs/九期/`](specs/九期/)。  
> **进度 2026-08-17**：P9.1–P9.9 **done**。

| # | 锁定做法 | Spec |
|---|---|---|
| 10 | 低分过滤默认开；真模型 rerank 默认关 | [P9.3](specs/九期/P9.3-fusion-rescore.md) |
| 11 | cosine re-score | [P9.3](specs/九期/P9.3-fusion-rescore.md) |
| 12 | facts 量纲 + 趋势查询 | [P9.5](specs/九期/P9.5-temporal-facts.md) |
| 13 | embedding 三档，默认 openai | [P9.2](specs/九期/P9.2-embedding-providers.md) |
| 14 | content_hash 语义白名单 | [P9.1](specs/九期/P9.1-content-hash.md) |
| 15 | source 解析 7 层 | [P9.4](specs/九期/P9.4-source-resolve.md) |
| 19 | outcome 回写，不自动 active | [P9.6](specs/九期/P9.6-outcome-boot-inject.md) |
| 21 | rrf×(k+1)；hotness 乘法 | [P9.3](specs/九期/P9.3-fusion-rescore.md) |
| 25 | 启动注入 top 经验 | [P9.6](specs/九期/P9.6-outcome-boot-inject.md) |
| 27 | back-link + `[Source:]` | [P9.7](specs/九期/P9.7-iron-law.md) |
| 41 | 写路径默认入队 | [P9.8](specs/九期/P9.8-async-write.md) |
| 42 | 蒸馏读 merge_op | [P9.9](specs/九期/P9.9-merge-op-distill.md) |

## 优先级总览

| # | 事项 | 对照 | 状态 |
|---|---|---|---|
| 1 | inbox 会话挂钩 | 08 D6/§10；原 P4.2 B | **P8.1 done**（2026-08-17 真机 `next` 当步生效已验证） |
| 2 | memory_remember 异步 | 08 §6「写入不阻塞」 | **P9.8 done**（CLI 默认入队；插件共用 core JobRunner） |
| 3 | per-call brain | 08 D2 多 brain | **P8.5 done** |
| 4 | 抽取粒度 | 08 §6.3 prompt 即规格 | **P8.4 done** |
| 5 | 懒蒸默认 5→3 | 仓配置已有 | **不做 Spec** |
| 6 | 分层检索标注 | 08 §6.5 / §7 分层加载 | **P8.2 done** |
| 7 | Skill 查找+注入 | 08 D5/D6；纠正「独立抽取」 | **P8.3 done** |
| 8 | 图谱规则密度对齐 gbrain | 08 §6.6 / §7.3 / §7.5 NER | **P10.2 done** |
| 9 | 真 pgvector（vector 列 + HNSW） | 08 §5.2 引擎 | **本期不做**（2026-08-20） |
| 10 | 真模型 rerank + 低置信过滤 | 08 §7.1 cross-encoder | **做**：低分过滤默认开；真 rerank 默认关，失败 local→不 rerank |
| 11 | 融合后 cosine re-score | 08 §7.1；gbrain 管线 | **做**：embedding 可用即跑（含哈希 local）；0.7/0.3 可配 |
| 12 | temporal 趋势检索 | gbrain find_trajectory | **做 C**：facts 可选 metric/value/unit/period + 趋势查询；无量纲 facts 不参与 |
| 13 | 真模型/本地小模型 embedding | 08 §5.6 默认 bge/ONNX | **做**：三档 `openai`（默认）/ `onnx` / `local` 哈希；无 Key fail-open 哈希。改 ADR |
| 14 | content_hash 未归一化 | 08 §5.3 | **做**：语义字段白名单 hash，剔除时间戳 |
| 15 | source 解析链 7 层只实现 3 层 | 08 §4.2 | **做 C**：按 08 补齐 7 层 |
| 16 | 索引表缺口 facts / event_ledger | 08 §5.2 | **不做**（文件即索引；#12 扫 md） |
| 17 | 矛盾分类（cosine + LLM 三分类） | 08 §8.3 | **P10.3 done（B）**；C 不做 |
| 18 | compiled_truth / synopsis + 2.0x | 08 §5.2 | **不做**（经验页即理解层；不建实体百科、不 ×2） |
| 19 | skill 状态机 + onSkillOutcome | 08 §9.1 / §13 | **做 B**：outcome 回写；不自动 active（前端可展示） |
| 20 | memory_diff 未覆盖 L0 capture | 08 §6.0 | **下期 C**（与 #37 同事务） |
| 21 | RRF 量纲对齐 + hotness 乘法 + per-arm floor | 08 §7.1 / §7.2 | **做**：`rrf*(k+1)`，**不做 sigmoid**；hotness 改乘法，**α 待定**（现 0.45 加法不合理） |
| 22 | observer 缺 latency / evidence 分布 | 08 §7.7 | **P10.4 done**（与 #32 同一 Spec） |
| 23 | MCP / REST / `memory serve` | 08 D7 / §12 / §15 | **不做** |
| 24 | harness 适配器（Claude/Codex/OpenCode/OpenClaw） | 08 D16 / §10.1 | **不做**（仅 DSH；Cursor 仍不做） |
| 25 | 启动被动注入 top 经验+skill；系统级 Skill>经验>源 | 08 D6 / §10 | **做 B**：启动只注 top 经验；skill 仍 P8.3 按需；不做三层强制排序 |
| 26 | dream 九段 vs 现网五段 | 08 §8.1 | **明确裁剪** |
| 27 | Iron Law back-link + `[Source:]` | 08 §8.2 | **做 C**：写后 back-link + facts 内联 `[Source:]`；不扩 dream 九段 |
| 28 | schema pack 仅 `problem-tree` | 08 §4.4 | **明确裁剪** |
| 29 | WRITE_FORMAT 敏感字段 mask | 08 §6.2 | **下期**（开工前再问范围） |
| 30 | 每 source `facts.md` | 08 §5.1 | **不做**（facts 只在节点 frontmatter） |
| 31 | tokenmax **LLM** 扩写 | 08 §7.1 | **不做**（调用方是 AI） |
| 32 | explain 缺 query_plan / searched_directories / 分母级 score_details | 08 §7.7 | **P10.4 done**（与 #22 一起） |
| 33 | Java 17 并行方案 | 08 D10 / §13 方案 B | **明确不做** |
| 34 | 开源治理面（llms.txt / examples / CONTRIBUTING / `memory upgrade`） | 08 §15 | **下期**（upgrade 依赖重开 #36；见文首） |
| 35 | 公开 bench：LongMemEval_S / HaluMem | 08 §15；[`reports/10`](reports/10-公开记忆Benchmark调研.md) | **下期**（开工前再问） |
| 36 | `@lhdrc/core` npm publish | P4.2 A | **不做**（下期若做 #34 upgrade 须先重开此项） |
| 37 | 事件账本缺 `node_created` | 08 §4.5；与 #20 同根 | **下期 C**（与 #20 同事务） |
| 38 | df-app skill → mcphub 同步 | 08 §9.3 | **不做** |
| 39 | Idle TTL / token 守护进程 | 六期 README 裁掉 | **明确不做** |
| 40 | 多模态记忆 | 08 §1 非目标 | **明确不做** |
| 41 | L0 `capture` 热路径仍同步 | 08 §2 / §6.1 | **P9.8 done**：写路径默认入队；同步须 `--wait`；JobRunner 在 core |
| 42 | pack `merge_op` 未驱动节点更新 | 08 §6.2 / §13 `updateNode` | **做 B**：蒸馏/经验合并读 merge_op；L0 仍 ADD-only |
| 43 | df-app 摄取仅 fixture | 08 D9 | **不做**（fixture 留样例；生产摄入 = DSH） |

#1–#7 为八期评审痕迹。#8–#22 为先前 08/面试审计。#23–#43 为本次补全。裁剪见八期 README §0。下列正文 **与 Spec 冲突时以 Spec 为准**。

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

## 8. 图谱建图/查询规则密度对齐 gbrain（面试评审发现，未排期）

**结论**：结构同构（四 pass + typed edges + 关系模板 + graph signals，均对齐 gbrain 思路），但规则密度与工程防御是 gbrain 的子集。gbrain 有 BrainBench 数据证明图是承重墙（graph 关 → P@5 ~18；全栈 49.1，**+31.4**，`reports/01` §5.1）。

**差距清单**（对照 `reports/01` §4.2/§5.3–5.5）：

| 项 | 现状（本仓） | gbrain | 建议 |
|---|---|---|---|
| 动词规则库 | `link-extraction.ts` 默认仅 4 条（决定/产出/负责/属于） | FOUNDED/INVESTED/ADVISES/WORKS_AT 等 + 中文模式（ZH_FOUNDED_RE） | 扩词表 + pack `extraVerbs` 化 |
| page-type 绑定边类型 | 无 | media→mentions、image→image_of、meeting→attended | 按 schema_type 绑定默认边类型 |
| link_kind 细分 | 无（仅 source 字段） | v98 加 link_kind | 预留列，低优先 |
| 批量写入 | 逐条 INSERT | `INSERT ... SELECT FROM jsonb_to_recordset`，17K 页秒级 | 批量写入（图大时收益） |
| ReDoS / STOPWORD 防御 | 无 | 有（relational recall arm） | 查询解析端补 |
| seed 置信门控 | 无（子串命中即种子） | confidence-gated | 邻接臂种子过滤 |
| 查询批量回填 | BFS 逐节点 SQL（N+1） | batch-hydrate | 路径批量 IN（已在 hydrate 端做，遍历端待合并） |
| 评测佐证 | mini 夹具 12 条 | BrainBench +31.4 P@5 实证 | 关系查询专项夹具 |

**2026-08-16 锁定：下期做。2026-08-20：Spec [`P10.2`](specs/十期/P10.2-graph-verbs.md) ready。** 建议切片见文首「下期」表。先按 P10.2 编码。

---

## 9. 真实 pgvector 落地（vector 列 + HNSW，面试评审发现，未排期）

**现状**（已核实）：pgvector 目前仅做**探测门控**——`postgres.ts` 连接时 `CREATE EXTENSION IF NOT EXISTS vector` 探测可用性；但 `chunks.embedding` 列在 postgres 路径上也是 `BYTEA`（`schema.sql` 两引擎共用），语义臂 `semantic.ts` 拉全量向量在 JS 算余弦，**未使用 vector 类型列、`<=>` 算子或 HNSW 索引**。PGLite 路径同构。

**差距**（对照 `reports/01` §5.1：gbrain 用 pgvector HNSW 向量臂；`specs/五期/P5.7` 只承诺探测与降级，未承诺真向量加速）：

| 项 | 现状 | 目标 |
|---|---|---|
| 列类型 | `chunks.embedding BYTEA` | postgres 路径改用 `vector(dims)` 列 |
| 距离计算 | JS 全量拉取 + 余弦（O(n) 内存/CPU） | `<=>` / `cosine_distance` SQL 算子 + 索引加速 |
| 索引 | 无 | HNSW 索引（`hnsw (embedding vector_cosine_ops)`） |
| 引擎分支 | `SqlClient` 无分叉 SQL | 两引擎最小 SQL 面分支（P5.7 §3 已留 `pgvector` 标志位） |
| 迁移 | — | BYTEA → vector 列迁移 + `rebuild-index --embeddings` 兜底（D1） |

**约束**：PGLite 无 pgvector，默认档语义臂**保持** BYTEA + JS 余弦不变（engine parity：同 schema 前提下允许 SQL 分叉，行为须一致）；postgres 无 pgvector 时仍 fail-open 降级。

**2026-08-16 锁定：下期做（B）。2026-08-20 用户：本期不做。** 仅 postgres 真 vector + HNSW；PGLite 不动。不进十期 P10.2–P10.4。

---

## 10. 真模型重排序 + 低置信度过滤（面试评审发现，未排期）

**现状**：`search.tokenmax.rerank` 仅支持 `local`（启发式：查询词在 title/snippet 的命中打分，`rerank.ts`）；LLM/真模型 rerank 是接口预留、kill-switch 默认关。**无低置信度过滤**——语义臂/图臂召回的低分项照常进榜。

**差距**（对照 gbrain `zerank-2` reranker，`reports/01` §5.5）：

| 项 | 现状 | 目标 |
|---|---|---|
| 重排序 | local 启发式（词命中） | 真模型 rerank（可配置，kill-switch 默认关保持现状） |
| 置信度过滤 | 无 | 低分/低置信度命中过滤（RRF 融合分阈值或 reranker 分数门） |
| 预算/降级 | 无 | rerank 失败 → 回退 local → 回退不 rerank（fail-open 链） |

**约束**：默认档零模型不变（rerank 默认关）；`--explain` 的 `rerank` 状态字段已预留 `skipped/local`，需加真模型档位。

---

## 11. 融合后 cosine re-score（面试评审发现，未排期）

**现状**：`fuseHybridArms` 融合即终分，之后只做 signals/hotness/预筛乘子，**无重打分**。

**差距**（对照 gbrain hybrid 管线：RRF → normalize → boost → **cosine re-score（0.7×rrf + 0.3×cosine）** → dedup，`reports/01` §5.2）：

| 项 | 现状 | 目标 |
|---|---|---|
| 融合后重打分 | 无 | 对候选集用查询向量与命中向量 cosine 再打分（0.7/0.3 或可配置） |
| 时机 | — | 在 fusion 之后、graph signals/hotness 之前 |
| 引擎差异 | — | 需命中 chunk embedding（当前查询侧已有 embedder；注意 embedding off 时跳过） |

**约束**：embedding off 时跳过该步骤（语义臂本就不可用）；不影响无语义权重档。

**2026-08-16 锁定**：做（B）。embedding 可用即跑，**含** `local` 哈希档（收益小也跑）；系数默认 0.7×rrf_norm + 0.3×cosine，可配。时机仍在 fusion 之后、graph signals / hotness 之前。

---

## 12. temporal 趋势检索（面试评审发现，未排期）

**现状**：检索只按 `updatedAt` 做 hotness 时效衰减（`hotness.ts`），**无趋势/回归检测**。

**差距**（对照 gbrain `find_trajectory`：按 (metric,value) 连续对检测回归，新值比旧值低 ≥10% 触发；Drift score = `1 - mean(cosine(emb[i], emb[i-1]))`，`reports/01` §4.6）：

| 项 | 现状 | 目标 |
|---|---|---|
| 指标变化检测 | 无 | facts/take 的 (claim_metric, value) 时间序列回归检测 |
| 趋势查询 | 无 | "这个指标最近在恶化吗"类查询入口 |
| 时间轴数据 | 事件账本有 `events/` 时间戳 | 需 facts 带 metric/value/period 字段（gbrain v82 已加 event_type） |

**约束**：需要写入侧先沉淀带量纲的事实（当前 `WRITE_FORMAT` facts 无 metric/value 字段，需先改 Spec）；v1 可不做，维持 hotness 兜底。

---

## 13. 真模型 embedding 落地（默认档升级路径，面试评审发现，未排期）

**现状**：`embed/openai.ts` 的 OpenAIEmbedding **已实现**（`embedding.provider: openai` + `OPENAI_API_KEY`）；但默认 `local` 档是**确定性哈希嵌入**（`embed/local.ts`，bigram 哈希 + L2 归一化），语义质量弱于真模型；换 provider/维度变化已有 `embeddingMetaMismatch` 检测（`hybrid.ts:69`）拒绝陈旧向量，需 `rebuild-index --embeddings`。

**差距**（对照 gbrain 默认即真 embedding + pgvector HNSW；`reports/01` §5.1）：

| 项 | 现状 | 目标 |
|---|---|---|
| 默认档语义质量 | local = 确定性哈希 | 本地可跑的真模型嵌入（如 ONNX/transformers.js 类，离线、无 API key）作为 local 档升级；或至少文档化 openai 升级路径 |
| 升级体验 | 手动改配置 + `rebuild-index --embeddings` | init/CLI 一键切换 + 自动重建提示（meta 检测已就绪） |
| 文档 | 无升级指引 | 写清 provider=local（哈希，保底）/ openai（真模型，需 key）的选择与重建步骤 |
| 索引加速 | 无（JS 余弦 O(n)） | 已在 **#9**（pgvector HNSW）覆盖，不重复 |

**约束**：默认零依赖离线不变（不能默认联网）；`local` 档改造后须保持确定性、可复现、无网络；相关测试（P21a-05 等）须保持绿。

---

## 14. content_hash 未归一化（08 §5.3 审计发现，未排期）

**现状**：`sync.ts:90` 直接用 `sha256Hex(raw)` 对**全文**（含 frontmatter）哈希。设计 §5.3 明确要求："hash 应对语义稳定字段归一化（**至少剔除纯时间戳型 frontmatter，如 `captured_at`**），避免「每次 capture 必变 hash」"。当前 frontmatter 含 `created_at` 等时间戳 → **同一内容每次写入 hash 必变 → 索引幂等短路失效，重复分块/重嵌入**。

**目标**：hash 计算时剔除时间戳类字段（白名单式保留语义字段，如 title/body/schema_type/links/facts/aliases 等）或对 frontmatter 做稳定化序列化。

**约束**：改动须保证「内容语义未变 → hash 不变」且「内容变了 → hash 变」两个方向都成立；现有 M3 系列测试（hash 短路）须保持绿；与 P5.1 余弦去重（enrich 层）互补，不冲突。

---

## 15. source 解析链 7 层只实现 3 层（08 §4.2 审计发现，未排期）

**设计**：`--source flag → env → .dfmemory-source dotfile → 路径前缀匹配 → brain 级 sources.default → sole_non_default（单 source 自动路由）→ 字面 'default'`，7 层。

**现状**（`cli/src/context.ts:30` + 各命令 `o.source ?? ctx.sourceId`）：仅实现 **--source flag → env（DF_MEMORY_SOURCE）→ brain.yml sources.default** 三层。注意：`createBrain` **创建了 `.dfmemory-source` 标记文件**（`repo/brain.ts:96-99`），但**没有任何代码读取它**——文件是死配置。sole_non_default 自动路由也无。

**目标**：补齐 dotfile 读取层 + sole_non_default 层（或明确裁剪并从创建逻辑中移除死文件，二选一，避免死配置残留）。

---

## 16. 索引表缺口：facts / event_ledger（08 §5.2 审计发现，未排期）

**设计索引清单**：`pages / chunks / links / facts / experiences / skills / entity_registry / event_ledger / search_cache / change_log`。`schema.sql` 实际只有：pages / chunks / entity_registry / links / search_cache。

| 表 | 现状 | 说明 |
|---|---|---|
| `facts`（hot memory） | 无表 | facts 只在 frontmatter 文件里；P5.1 dedupe 读文件而非索引；查询不消费 facts 索引 |
| `event_ledger` | 无表 | `events list` 直接扫 `events/YYYY-MM/ledger.jsonl`（`ledger.ts`）；设计另写形状 `{slug}.jsonl`，实现为单文件 `ledger.jsonl` |
| `change_log` | 无表（文件版在） | `memory_diff.jsonl` 文件实现可用（`changes` 命令），可视为裁剪 |
| `experiences/skills` | pages 行承载 | syncAll 将 experiences/skills 的 md 按 page 索引（path 过滤）——**设计收敛，可接受** |

**目标**：facts/event_ledger 按需补索引表（时间线/溯源/冲突检测用），或显式声明"文件即索引"裁剪并更新 08。

**2026-08-16 锁定：不做。** 不建派生表。facts 只在 frontmatter；event_ledger 继续扫 `ledger.jsonl`。08 改为「文件即索引」裁剪。#12 趋势扫 md，不依赖本表。

---

## 17. 矛盾分类简化（08 §8.3 审计发现，未排期）

**设计**：矛盾分类 = cosine ≥0.95 快路径判 DUPLICATE（零 LLM）→ LLM 三分类 duplicate/supersede/independent → LLM 失败时 cosine ≥0.92 兜底 DUPLICATE → 结果写 `contradictions.md`。

**现状**：dream phase 4 只做**同文件内 facts 文本重叠启发式**（`dream/runner.ts:147-167`，去空白小写比较 + event_type 同型），跨文件/近似语义矛盾不检测；无 cosine 快路径、无 LLM 三分类、无降级。

**目标**：至少补 cosine 快路径（跨文件近似事实对）+ 冲突写 `contradictions.md`；LLM 三分类按 P7.x 的 `complete()` 接入；降级链按设计。

**2026-08-16 锁定：下期。2026-08-20：锁 B，Spec [`P10.3`](specs/十期/P10.3-contradictions.md)。** 无 facts 表（#16 不做）则扫 md；`local` 哈希档跳过跨文件 cosine。产出只写 `contradictions.md`，不接 hybrid。C（LLM 三分类）不做。

---

## 18. compiled_truth / synopsis 理解层缺失（08 §5.2 / §4.1 审计发现，未排期）

**设计**：`pages` 表含 `compiled_truth`（brain 对实体的跨来源综合理解，由 dream synthesize 生成）+ `synopsis`；检索命中时 compiled_truth **2.0x boost**（gbrain 实证：检索质量的关键承重墙之一）。

**现状**：无此列、无 synthesize 阶段（dream 已裁 5 段）、无 boost。我们只有 L1 abstract（单篇）与 experiences（经验教训），都不是"对实体的综合理解"。

**目标**：需先定义"综合理解"的生成源（dream synthesize 或 distill 副产品）+ 存储（frontmatter 或 sidecar）+ 检索 boost；先改 Spec（08 需补实现形态）再改代码。

---

## 19. skill 状态机 + onSkillOutcome 缺失（08 §9.1 / §13 审计发现，未排期）

**设计**：状态机 candidate → active → archived；反例收集（skill 被用但失败 → counter_examples → rework/archive）；`SkillService.onSkillOutcome(skillName, success)` 更新 eta/support/reward。

**现状**：结晶有 candidate + eta/support/counter_examples **字段**（`crystallize.ts`，P3.2 已实现字段与成熟判定）；但**无状态机晋升（candidate→active 需验证）、无 onSkillOutcome 回写接口、无反例自动收集**。P8.3 只做查找/注入面。

**目标**：补 outcome 回写接口（注入后 success/fail → 更新 support/eta/counter_examples）+ 状态机判定；先改 Spec（P8.3 补丁或新 Spec）。

---

## 20. memory_diff 未覆盖 L0 capture（08 §6.0 审计发现，未排期）

**设计**："memory_diff 覆盖 **L0–L3 全部变更类**"（D17 冲突裁决节）。

**现状**：`appendMemoryDiff` 只在 distill/refine（experience_*）、enrich（facts/skip 审计）、crystallize 写；**L0 热路径 capture 本身不写 memory_diff**（L0 变更只在 events ledger 有 capture 事件？——需确认并补）。

**目标**：capture 落盘后在单写事务内 append `op: create`（或 node_created，`reports/12` 已指出事件账本缺 node_created——同根问题）；保证 `changes` 命令能审计 L0 写入。

**2026-08-16 锁定：下期做 C。** 与 #37 同一写事务：`memory_diff op:create` + `node_created`。不另建 ledger 表。

---

## 21. RRF 量纲对齐 + hotness 乘法 + per-arm floor（08 §7.1 / §7.2）

**设计（08 原文）**：`RRF 融合（k=60）+ 归一化（Mem0 自适应 sigmoid）+ 调权`；`threshold 前置：单一通道分 < floor 剔除`。

**现状**（`rrf.ts` / `hotness.ts`）：RRF 后直接乘权重；**无** sigmoid / rescale。`HOTNESS_WEIGHT = 0.45` **加法**并入终分（`score + 0.45 * recency`），与 RRF 量纲（rank1 ≈ 0.016）完全不对齐，时效可以碾压相关度。无 per-arm floor。

**2026-08-16 锁定**（不做 08 sigmoid / 不做 min-max / **k=60 不动**）：

```
rrf' = rrf * (k + 1)          # rank1 → 1.0，与 title/entity 同量纲
final_rel = Σ w * rrf' + w_title*title + w_entity*entity
score     = final_rel * (1 + α * hotness)
```

- per-arm floor 与 #10 低分过滤一起做（默认开）。
- `TIE_BREAK_EPS` 按 rescale 后分差重钉（现 0.01 会几乎总触发）。

**待定（必须进 Spec，禁止沿用 0.45）**：乘法系数 **α**。当前加法 0.45 不合理；α 建议从 0.1–0.2 起用夹具看时效是否仍压过相关度，**数字未锁定**。title/entity 权重在 rescale 后也可能要重标定。

---

## 22. observer 缺 latency / evidence 分布（08 §7.7 审计发现，未排期）

**设计**：`observer` 命令看整体指标（total / zero-result / avg score / **latency** / **evidence 分布**）。

**现状**（`observer/stats.ts`）：有 query_count / zero_result_rate / avg_score / distill_count / cost；**无 latency、无 evidence 分布**（evidence: keyword/semantic/graph 占比无法观测）。

**目标**：query log 增记 latency + evidence 统计，observer 输出分布。

**2026-08-16 锁定：下期，与 #32 同一 Spec。2026-08-20：[`P10.4`](specs/十期/P10.4-query-observe.md) ready。** query log 记 latency + 各臂 evidence；observer 出分布。

---

## 23. MCP / REST / `memory serve`（08 D7 / §12 / §15，后置）

**设计**：agent 主通道是 MCP（`memory_find/read/grep/list/remember/forget/refine`）+ REST（`POST /api/memory` 等）+ `memory serve`；`packages/mcp` 进仓库结构。

**现状**：无 `packages/mcp/`、无 REST server、无 `memory serve`。DSH 插件用另一套工具名（`memory_query` / `memory_tree` / `memory_capture`）。P4.1 Spec 仍 draft 后置。

**后续**：用户点名再立 P4.1；不要用 DSH 工具名冒充 MCP 契约已交付。

---

## 24. harness 适配器（08 D16 / §10.1，后置）

**设计**：Claude Code（CLAUDE.md + SessionStart hook）、Codex（AGENTS.md）、OpenCode、OpenClaw、df-app 沙箱各一份「启动注入 + 结束提交」适配器；`/examples`。

**现状**：仅并列仓 `dsh-df-memory/`（Cordis）。P6.5 Cursor 模板**明确不做**。无 CLAUDE.md / examples。

**2026-08-16 锁定：A，不做。** 主通道维持 DSH 插件。不写各家 hook / examples。Cursor 仍不做。08 D16 改为裁剪。

---

## 25. 启动被动注入 + 系统级优先级（08 D6 / §10，未排期）

**设计**：任务启动注入 project 级经验 top-3 + 命中 skill 进 SYSTEM_PROMPT；运行时再主动查。优先级 **Skill > 成熟经验 > 原始记忆**；「不直接注入原始记忆」。

**现状**：P8.1 是 `shouldQueryMemory` 命中后 `memory_query` 注入 **知识 hits**（含 L0）；P8.3 skill **按需** inject。没有启动必注 top 经验，也没有系统级三层排序（P8.2 只写进 prompt 文案）。

---

## 26. dream 九段 vs 五段（08 §8.1，明确裁剪）

**设计**：lint / backlinks / sync / synthesize / extract / patterns / recompute_weight / embed --stale / orphans + 蒸馏补跑 / 矛盾 / 结晶。

**现状**：P3.2 v1 五段：lint / sync / distill_pending / contradictions / orphans。AGENTS 硬约束「不扩 dream 夜间维护全集」。

缺段计入差距，**不**当作八期漏做。

---

## 27. Iron Law back-link + `[Source:]`（08 §8.2，未排期）

**设计**：提到有实体页的人/公司必须 back-link；每条事实带 `[Source: ...]` 内联引用。

**现状**：`linkifyBody` 挂 `@slug`；无强制反向链接、无内联 Source 引用。dream 也无 backlinks 段（见 #26）。

**2026-08-16 锁定：C，做。** 提及已有实体页 → 实体页补反向链；facts 内联 `[Source: …]`。走写后 enrich / compile 路径，**不**因此把 dream 扩成九段（#26 裁剪仍有效）。

---

## 28. schema pack 仅 problem-tree（08 §4.4，明确裁剪）

**设计**：核心不硬编码路径；可换 `topic-tree` / `wiki-tree`；`memory schema use` 切换。

**现状**：默认且唯一交付 pack 是 `problem-tree`。`schema use` 能换 pack 文件，但仓库不提供第二份 pack。AGENTS：七期不做新 pack。

---

## 29. WRITE_FORMAT 敏感字段 mask（08 §6.2，未排期）

**设计**：可配 mask，敏感字段拒绝或打码。

**现状**：`WRITE_FORMAT.md` / validator 无 `sensitive.mask`；无对应 `memory.yml` 项。

**2026-08-16 锁定：下期。范围未锁。**  
**门闩**：下期开工前必须再问用户（拒绝 vs 打码 vs 仍不做）。禁止直接按 08 mask 开工。

---

## 30. 每 source `facts.md`（08 §5.1，未排期）

**设计**：facts 权威在节点 frontmatter **或** 每 source 一个 `facts.md`（pack 二选一）。

**现状**：只实现 frontmatter `facts` 块。无 `facts.md`、无索引 `facts` 表（#16）。

**2026-08-16 锁定：不做。** facts 权威只在节点 frontmatter。08 去掉 pack 二选一的 `facts.md` 分支。

---

## 31. tokenmax LLM 扩写（08 §7.1，未排期）

**设计**：tokenmax 用轻量 LLM 生成 2–3 查询变体，各跑全栈后 RRF 合并。

**现状**：`heuristicExpand`（去停用词 / 词序），不调 `complete()`。与 #10（真 rerank）分开：一个是扩写，一个是重排。

---

## 32. explain 轨迹不全（08 §7.7，未排期）

**设计**：每结果 `evidence` + `score_details`（各通道分/分母/阈值）；返回 `searched_directories` + `query_plan`。

**现状**：hit 有 `evidence` 标签；`--explain` 有 intent/mode/arms/signals/dir 预筛。无 `query_plan`、无 `searched_directories` 下钻列表、无分母/阈值级 `score_details`。observer 分布见 #22。

**2026-08-16 锁定：下期，与 #22 同一 Spec。2026-08-20：[`P10.4`](specs/十期/P10.4-query-observe.md) ready。** 补齐 `query_plan`、`searched_directories`、分母/阈值级 `score_details`。

---

## 33. Java 17 方案 B（08 D10，明确不做）

AGENTS / 08 决策建议主推 TS/Bun。不实现 Java、不并行维护两套核心。

---

## 34. 开源治理面（08 §15，未排期）

**设计**：`packages/mcp`、`/docs`（CLAUDE.md、llms.txt、KEY_FILES、RESOLVER）、`/examples`、CONTRIBUTING.md、CHANGELOG、`memory upgrade` 自更新。

**现状**：有 AGENTS.md + Specs。无上述文件与命令。发布面另见 #36。

**2026-08-16 锁定：下期做。** `memory upgrade` = 升级已安装的 CLI/core（问 registry 比版本 → 装新包 → 可选迁移 `memory.yml`），不改记忆 md / AGENTS.md。  
**门闩**：本次 #36 不做 publish，upgrade 没有版本源。下期开工前必须先问是否同时 publish；否则只做 CONTRIBUTING/CHANGELOG，或整项再裁。不含 MCP、不含 #24 examples。

---

## 35. 公开 bench LongMemEval_S / HaluMem（未排期）

**设计**：08 §15 `/evals` LongMemEval；[`reports/10`](reports/10-公开记忆Benchmark调研.md) 把 LongMemEval_S 列为 P0、HaluMem-Medium 为 P1。

**现状**：P5.6 = `eval:mini` + `eval:distill` + LoCoMo **仓内 fixture**。LongMemEval 仍无 adapter。**HaluMem** 在 `eval4locomo` 已有 `halumem-v1` runner（`evals/halumem-run.ts`），但 QA **复用 LoCoMo `locomo-prompts.ts` J-score**，与论文官方口径不一致（见下）。

**待办（2026-08-21 会话）— HaluMem 官方口径对齐（P10.5 in_progress）**：

- [x] `evals/adapters/halumem-prompts.ts` — Appendix C.1/C.2 锁仓 + hash
- [x] `halumem-official-v1` 默认；`--protocol halumem-v1` 保留内部趋势
- [x] QA top_k=20；update verify top_k=10；LLM integrity/update/QA judge
- [ ] 全量 Medium 发数 + 操作门闩；memory accuracy（C.2 per-candidate）可选二期

**禁止**与 Mem0 等 HaluMem 榜数字无 protocol 声明对比。

**2026-08-16 锁定：下期。范围未锁。**  
**门闩**：下期开工前必须再问用户（上哪些 adapter、是否进 CI、与仓内 mini/LoCoMo 的关系）。禁止默认按 reports/10 把 LongMemEval_S 当九期/下期必做全量。

---

## 36. `@lhdrc/core` npm publish（P4.2 A，未排期）

插件 `package.json` 现为 `file:../lhdrcMem/packages/core`。未 publish 不阻塞八期代码 DoD，但阻塞「别人 `dsh plugin add` 不靠本地 path」。

**2026-08-16 锁定：不做。** 下期若做 #34 `memory upgrade`，必须先重开 publish，否则 upgrade 无 registry 可问。

---

## 37. 事件账本缺 `node_created`（08 §4.5，未排期）

**设计**：capture/update 进不可变事件流。

**现状**：无 `node_created` 事件类型（代码库零命中）。L0 写入可观测性依赖 #20 memory_diff。与 #16 文件形状（`ledger.jsonl` vs `{slug}.jsonl`）分开记。

**2026-08-16 锁定：下期做 C。** 与 #20 捆绑，见上。

---

## 38. df-app 结晶 skill → mcphub（08 §9.3，未排期）

**设计**：SKILL.md 与 df-app skill 同构，适配器可选同步进 mcphub。

**现状**：结晶只写 `brains/{id}/skills/`。无 mcphub / 分发通道。

**2026-08-16 锁定：A，不做。** 结晶只落本仓 `skills/`。P8.3 注入不经 mcphub。08 §9.3 改为裁剪。

---

## 39. Idle TTL / token 守护进程（明确不做）

六期 README：不做 Idle TTL / token 阈值守护进程。记入差距以免被当成「漏 Spec」。

---

## 40. 多模态（08 §1 非目标）

图像/工具轨迹后置。不做。

---

## 41. L0 capture 热路径仍同步（08 §2 / §6.1，未排期）

**设计**：「异步写入 + 可观测」；写入不阻塞。

**现状**：CLI `capture` / `compileSession` 默认同步走完写盘。仅 DSH `memory_remember` 默认入队（#2）。人手 capture 与会话 compile 仍堵调用方。

---

## 42. `merge_op` 未驱动更新（08 §6.2 / §13，未排期）

**设计**：pack 声明 immutable/patch/append；`updateNode` 按 merge_op 合并。

**现状**：pack YAML 有 `merge_op` 字段；L0 锁 ADD-only，没有通用 `updateNode`。经验层 merge 走蒸馏词表，不读 pack merge_op。

**2026-08-16 锁定：B，做。** 蒸馏/经验合并按 pack `merge_op` 执行；L0 继续 ADD-only，不做通用 `updateNode`。不改 D17。

---

## 43. df-app 摄取仅 fixture（08 D9，未排期）

**设计**：df-app 是第一生产适配器，映射 workspace/issue → brain/source。

**现状**：`packages/adapters/ingest-df-app` 只消化仓内 `sample-export.jsonl`（P5.8 DoD）。未接真实 df-app 消息流。

**2026-08-16 锁定：A，不做。** fixture 保留当格式样例。生产摄入 = DSH 挂钩。08 D9「第一生产适配器」改为裁剪。

---

## 备注

- **本次重审（2026-08-16）**：#23–#43 补 08 里「有章节、无 Spec 主人」的项；已落地（混合检索骨架、graph signals、search_cache、分层 sidecar、DSH 闭环等）不重复列。
- **先前审计**：#8–#22；#8 含 §7.5 NER 类型链接，不另开号。
- **明确不做 / 后置** 仍占行，避免再被当成「AI 漏拆」。
- 推进任一项：先改对应 Spec/08，再改代码。
- **下期项** 以文首「下期」表为准；会话里说「下期再做」必须回写该表，不能只留在对话。
