# TODO — 08 对照实现的差距账本

> **出身**：2026-08-15 会话评审七项（已收成八期 Spec）。  
> **2026-08-16 全量重审**：按 `[reports/08-开源记忆模块设计方案.md](reports/08-开源记忆模块设计方案.md)` 逐章对照代码 / Spec DoD。**已落地章节不列入**。本文件 = 差距全集，不是执行排期。  
> 原则：先改 Spec/08 ADR 再改代码（AGENTS.md）。与八期 Spec 冲突时以 Spec 为准。

## 下期（2026-08-16 会话锁定）

> **九期不立这些 Spec。** 下期开工仍先改 Spec/08。本表只收「明确下期做」；后续对话追加，禁止只停在聊天里。  
> **2026-08-20**：#8 / #17-B / #22+#32 已落地 `[specs/十期/](specs/十期/)`（P10.2–P10.4 **done**）。**#9 本期不做**。#17 **锁 B**（禁止 C）。  
> **2026-08-21**：#44–#48 收成 `[specs/十一期/](specs/十一期/)`（范围选择 / hotness freq / 变更可写 / 旧事实降权 / 实体槽位）。**不**含 #9 / #17-C / #20+#37 / #29 / #34 / LongMemEval。  
> **2026-08-23**：#49 冲突人工审阅 + 失效软删。**P11.6 done**。修订 P11.4：未审不自动降权。  
> **2026-08-26**：#20+#37 L0 审计 **P11.7 done**。#49 **P11.6 done**。  
> **2026-08-27**：GroupMemBench Technology 全量（3 万 md / ~6 万 chunk / Qwen 4096 维）证明 JS 全表余弦不够用。用户要求 **main 收嵌入热路径（#50）**，并重开 **#9 postgres** `vector` **+ HNSW**。PGLite 默认档仍 BYTEA，不假装有 pgvector。  
> **2026-08-28**：#50 **P12.1 done**。P12.2 宿主信封 + P12.3 `memory config` **done**。失败/降级账本同期落盘。**#9 仍未编码**。


| #     | 锁定做法                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8     | 图谱规则密度对齐。扩动词 + pack `extra_verbs`、邻接种子门控、STOPWORD/ReDoS、关系查询夹具。不做 `link_kind` / 批量 jsonb 写入 / page-type→默认边。**Spec** `[P10.2](specs/十期/P10.2-graph-verbs.md)`                            |
| 9     | postgres 真 `vector` + HNSW。**2026-08-20 曾裁「本期不做」。2026-08-27 重开**：仅 postgres 引擎；无 pgvector fail-open BYTEA；PGLite 不动。须先改 Spec/08 再编码。                                                     |
| 50    | main 嵌入/语义臂热路径（PGLite 也要）：打分不拉全表 `text`、Float32 视图、`embedding IS NULL` 续跑、兼容网关 5xx 重试；长驻进程可按仓缓存向量。不替代 #9。**Spec** `[P12.1](specs/十二期/P12.1-embed-hotpath.md)` **done**                   |
| 17    | **B**：跨文件 cosine → 只写 `contradictions.md`；同文件启发式保留；不改 hybrid；无 LLM 三分类；`local` 哈希档跳过跨文件 cosine。**Spec** `[P10.3](specs/十期/P10.3-contradictions.md)`。C 另开 Spec                            |
| 20+37 | **C**：L0 capture 同一写事务内 `memory_diff` `op: create` + 事件账本 `node_created`。`changes` 能审计 L0；ledger 仍 jsonl（#16 不做表）。**Spec** `[P11.7](specs/十一期/P11.7-l0-audit.md)` **done**               |
| 22+32 | observer 补 latency + evidence 分布；`--explain` 补 `query_plan` / `searched_directories` / 分母级 `score_details`。同一套 query log。**Spec** `[P10.4](specs/十期/P10.4-query-observe.md)`             |
| 29    | 敏感字段 mask。范围未锁（A 不做 / B 仅拒绝落盘 / C 拒绝或打码）。**下期开工前必须再问一次**，禁止默认按 08 打码开工。                                                                                                                  |
| 35    | 公开 bench LongMemEval_S / HaluMem。范围未锁。**下期开工前必须再问一次**（是否上 adapter、是否进 CI、和 `eval:mini` 的关系），禁止默认按 reports/10 P0 全量开工。                                                                    |
| 34    | 开源治理面（含 `memory upgrade`）。upgrade = 升 CLI/core 包版本 + 可选 `memory.yml` 迁移，**不改** `brains/`** / AGENTS.md。**无 npm publish（#36 本次不做）则 upgrade 无对象**；下期开工前必须先问是否同时重开 #36。不含 MCP/#24 examples。 |
| 44    | hotness 学 OpenViking：**freq × recency**。`freq=sigmoid(log1p(active_count))`；无计数时 freq=1。保持乘法与 **α=0.15**。**Spec** `[P11.2](specs/十一期/P11.2-hotness-freq.md)`                             |
| 45    | 意图→目录先验：先窄搜，证据不足再扩全仓。守 #6：必须 fallback，禁止无回退级联。CLI 默认关；`think` 默认开。**Spec** `[P11.1](specs/十一期/P11.1-scope-route.md)`                                                                     |
| 46    | 写入 duplicate≠update：prefetch 旧值必须再写新 item；余弦近但宾语不同不得跳过。L0 仍 ADD-only。**Spec** `[P11.3](specs/十一期/P11.3-update-write.md)`                                                                 |
| 47    | 旧事实让位：`contradictions.md` 较旧侧检索降权，不删 L0。**被 #49 修订**：未审不对 hybrid 自动降权。**Spec** `[P11.4](specs/十一期/P11.4-stale-demote.md)`                                                                |
| 48    | 实体槽位 `merge_op=patch`：同一主语当前值写实体 facts；`note: patch` 仍不驱动 L0。**Spec** `[P11.5](specs/十一期/P11.5-entity-slot.md)`                                                                          |
| 49    | 冲突标记 → **人工审阅**决定真相 → 失效侧 **fact 级软删**（`archived`/`superseded`，走 forget，不 rm）。未审 keep_both 可检索。无 LLM 终审。先改 P11.4。**Spec** `[P11.6](specs/十一期/P11.6-contradiction-review.md)` **done**    |




## 九期（2026-08-16 会话锁定）

> 先改 Spec/08 再改代码。**八期已关账（2026-08-17：P81-17 真机** `next` **当步生效已验证）**，不进九期 DoD。hotness **α 默认 0.15**（P9.3；禁止沿用加法 0.45）。规格：`[specs/九期/](specs/九期/)`。  
> **进度 2026-08-17**：P9.1–P9.9 **done**。


| #   | 锁定做法                    | Spec                                         |
| --- | ----------------------- | -------------------------------------------- |
| 10  | 低分过滤默认开；真模型 rerank 默认关  | [P9.3](specs/九期/P9.3-fusion-rescore.md)      |
| 11  | cosine re-score         | [P9.3](specs/九期/P9.3-fusion-rescore.md)      |
| 12  | facts 量纲 + 趋势查询         | [P9.5](specs/九期/P9.5-temporal-facts.md)      |
| 13  | embedding 三档，默认 openai  | [P9.2](specs/九期/P9.2-embedding-providers.md) |
| 14  | content_hash 语义白名单      | [P9.1](specs/九期/P9.1-content-hash.md)        |
| 15  | source 解析 7 层           | [P9.4](specs/九期/P9.4-source-resolve.md)      |
| 19  | outcome 回写，不自动 active   | [P9.6](specs/九期/P9.6-outcome-boot-inject.md) |
| 21  | rrf×(k+1)；hotness 乘法    | [P9.3](specs/九期/P9.3-fusion-rescore.md)      |
| 25  | 启动注入 top 经验             | [P9.6](specs/九期/P9.6-outcome-boot-inject.md) |
| 27  | back-link + `[Source:]` | [P9.7](specs/九期/P9.7-iron-law.md)            |
| 41  | 写路径默认入队                 | [P9.8](specs/九期/P9.8-async-write.md)         |
| 42  | 蒸馏读 merge_op            | [P9.9](specs/九期/P9.9-merge-op-distill.md)    |




## 十一期（2026-08-21 会话锁定）

> **进度 2026-08-26**：P11.1–P11.7 **done**（含 #49 人审、#20+#37 L0 审计；P11.4 默认 `stale_demote: false`）。


| #     | 锁定做法                     | Spec                                                   |
| ----- | ------------------------ | ------------------------------------------------------ |
| 45    | 意图→目录先验，不足再扩             | [P11.1](specs/十一期/P11.1-scope-route.md)                |
| 44    | hotness = freq × recency | [P11.2](specs/十一期/P11.2-hotness-freq.md)               |
| 46    | 写入 duplicate≠update      | [P11.3](specs/十一期/P11.3-update-write.md)               |
| 47    | 矛盾对较旧侧降权                 | [P11.4](specs/十一期/P11.4-stale-demote.md)（#49 修订：未审不降权） |
| 48    | 实体槽位 patch，不改 L0 note    | [P11.5](specs/十一期/P11.5-entity-slot.md)                |
| 49    | 人工裁决冲突 + 失效软删            | [P11.6](specs/十一期/P11.6-contradiction-review.md)       |
| 20+37 | L0 capture 审计            | [P11.7](specs/十一期/P11.7-l0-audit.md)                   |




## 优先级总览


| #   | 事项                                                              | 对照                                                   | 状态                                                                  |
| --- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | inbox 会话挂钩                                                      | 08 D6/§10；原 P4.2 B                                   | **P8.1 done**（2026-08-17 真机 `next` 当步生效已验证）                         |
| 2   | memory_remember 异步                                              | 08 §6「写入不阻塞」                                         | **P9.8 done**（CLI 默认入队；插件共用 core JobRunner）                         |
| 3   | per-call brain                                                  | 08 D2 多 brain                                        | **P8.5 done**                                                       |
| 4   | 抽取粒度                                                            | 08 §6.3 prompt 即规格                                   | **P8.4 done**                                                       |
| 5   | 懒蒸默认 5→3                                                        | 仓配置已有                                                | **不做 Spec**                                                         |
| 6   | 分层检索标注                                                          | 08 §6.5 / §7 分层加载                                    | **P8.2 done**                                                       |
| 7   | Skill 查找+注入                                                     | 08 D5/D6；纠正「独立抽取」                                    | **P8.3 done**                                                       |
| 8   | 图谱规则密度对齐 gbrain                                                 | 08 §6.6 / §7.3 / §7.5 NER                            | **P10.2 done**                                                      |
| 9   | 真 pgvector（vector 列 + HNSW）                                     | 08 §5.2 引擎                                           | **重开**（2026-08-27；曾 2026-08-20 裁）                                   |
| 10  | 真模型 rerank + 低置信过滤                                              | 08 §7.1 cross-encoder                                | **做**：低分过滤默认开；真 rerank 默认关，失败 local→不 rerank                        |
| 11  | 融合后 cosine re-score                                             | 08 §7.1；gbrain 管线                                    | **做**：embedding 可用即跑（含哈希 local）；0.7/0.3 可配                          |
| 12  | temporal 趋势检索                                                   | gbrain find_trajectory                               | **做 C**：facts 可选 metric/value/unit/period + 趋势查询；无量纲 facts 不参与      |
| 13  | 真模型/本地小模型 embedding                                             | 08 §5.6 默认 bge/ONNX                                  | **做**：三档 `openai`（默认）/ `onnx` / `local` 哈希；无 Key fail-open 哈希。改 ADR |
| 14  | content_hash 未归一化                                               | 08 §5.3                                              | **做**：语义字段白名单 hash，剔除时间戳                                            |
| 15  | source 解析链 7 层只实现 3 层                                           | 08 §4.2                                              | **做 C**：按 08 补齐 7 层                                                 |
| 16  | 索引表缺口 facts / event_ledger                                      | 08 §5.2                                              | **不做**（文件即索引；#12 扫 md）                                              |
| 17  | 矛盾分类（cosine + LLM 三分类）                                          | 08 §8.3                                              | **P10.3 done（B）**；C 不做                                              |
| 18  | compiled_truth / synopsis + 2.0x                                | 08 §5.2                                              | **不做**（经验页即理解层；不建实体百科、不 ×2）                                         |
| 19  | skill 状态机 + onSkillOutcome                                      | 08 §9.1 / §13                                        | **做 B**：outcome 回写；不自动 active（前端可展示）                                |
| 20  | memory_diff 未覆盖 L0 capture                                      | 08 §6.0                                              | **P11.7 done**                                                      |
| 21  | RRF 量纲对齐 + hotness 乘法 + per-arm floor                           | 08 §7.1 / §7.2                                       | **做**：`rrf*(k+1)`，**不做 sigmoid**；hotness 改乘法，**α 待定**（现 0.45 加法不合理） |
| 22  | observer 缺 latency / evidence 分布                                | 08 §7.7                                              | **P10.4 done**（与 #32 同一 Spec）                                       |
| 23  | MCP / REST / `memory serve`                                     | 08 D7 / §12 / §15                                    | **不做**                                                              |
| 24  | harness 适配器（Claude/Codex/OpenCode/OpenClaw）                     | 08 D16 / §10.1                                       | **不做**（仅 DSH；Cursor 仍不做）                                            |
| 25  | 启动被动注入 top 经验+skill；系统级 Skill>经验>源                              | 08 D6 / §10                                          | **做 B**：启动只注 top 经验；skill 仍 P8.3 按需；不做三层强制排序                        |
| 26  | dream 九段 vs 现网五段                                                | 08 §8.1                                              | **明确裁剪**                                                            |
| 27  | Iron Law back-link + `[Source:]`                                | 08 §8.2                                              | **做 C**：写后 back-link + facts 内联 `[Source:]`；不扩 dream 九段             |
| 28  | schema pack 仅 `problem-tree`                                    | 08 §4.4                                              | **明确裁剪**                                                            |
| 29  | WRITE_FORMAT 敏感字段 mask                                          | 08 §6.2                                              | **下期**（开工前再问范围）                                                     |
| 30  | 每 source `facts.md`                                             | 08 §5.1                                              | **不做**（facts 只在节点 frontmatter）                                      |
| 31  | tokenmax **LLM** 扩写                                             | 08 §7.1                                              | **不做**（调用方是 AI）                                                     |
| 32  | explain 缺 query_plan / searched_directories / 分母级 score_details | 08 §7.7                                              | **P10.4 done**（与 #22 一起）                                            |
| 33  | Java 17 并行方案                                                    | 08 D10 / §13 方案 B                                    | **明确不做**                                                            |
| 34  | 开源治理面（llms.txt / examples / CONTRIBUTING / `memory upgrade`）    | 08 §15                                               | **下期**（upgrade 依赖重开 #36；见文首）                                        |
| 35  | 公开 bench：LongMemEval_S / HaluMem                                | 08 §15；`[reports/10](reports/10-公开记忆Benchmark调研.md)` | **下期**（开工前再问）                                                       |
| 36  | `@lhdrc/core` npm publish                                       | P4.2 A                                               | **不做**（下期若做 #34 upgrade 须先重开此项）                                     |
| 37  | 事件账本缺 `node_created`                                            | 08 §4.5；与 #20 同根                                     | **P11.7 done**                                                      |
| 38  | df-app skill → mcphub 同步                                        | 08 §9.3                                              | **不做**                                                              |
| 39  | Idle TTL / token 守护进程                                           | 六期 README 裁掉                                         | **明确不做**                                                            |
| 40  | 多模态记忆                                                           | 08 §1 非目标                                            | **明确不做**                                                            |
| 41  | L0 `capture` 热路径仍同步                                             | 08 §2 / §6.1                                         | **P9.8 done**：写路径默认入队；同步须 `--wait`；JobRunner 在 core                 |
| 42  | pack `merge_op` 未驱动节点更新                                         | 08 §6.2 / §13 `updateNode`                           | **做 B**：蒸馏/经验合并读 merge_op；L0 仍 ADD-only                             |
| 43  | df-app 摄取仅 fixture                                              | 08 D9                                                | **不做**（fixture 留样例；生产摄入 = DSH）                                      |
| 44  | hotness 仅文件 mtime 衰减                                            | OpenViking `freq×recency`；P9.3 α=0.15                | **P11.2 done**                                                      |
| 45  | 意图只调融合权重，不改搜索空间                                                 | OpenViking 选目录；TODO #6 禁无回退级联                        | **P11.1 done**                                                      |
| 46  | 更新被 prefetch/余弦去重吞掉                                             | HaluMem Update Omission；D17 ADD-only                 | **P11.3 done**                                                      |
| 47  | contradictions.md 不接检索                                          | P10.3 留「过期降权另开 Spec」                                 | **P11.4 done**（默认关）                                                 |
| 48  | pack `note: patch` 死配置；实体 facts 只 append                        | OV 字段 merge_op；#42 已裁 L0 updateNode                  | **P11.5 done**`十二`                                                  |
| 49  | 冲突无人审、失效不软删                                                     | 现网只写 contradictions.md；forget 未接线                    | **P11.6 done**                                                      |
| 50    | 语义臂 O(n) 拉全文 + 无续跑/重试                                           | GroupMemBench 6 万×4096 维首问分钟级                        | **P12.1 done**；ANN 见 #9                                             |
| 51    | BM25 文章级倒排：清洗/物化/GIN + 长度归一 + 短语 | `pages` 全表 `ts_rank`、`fts_* TEXT`无GIN、bigram跨词噪音、长文无归一 | **规划中（2026-09-02）**；见正文 ## 51；不改 chunk/语义臂，文章级返回 |
| 52    | 图谱边类型建≡检索闭环：补 `decided/produced_by/belongs_to/invested_in/advises` 检索模板 | `links` 10种已建（`P10.2`），检索仅 `mentions/works_on/references/works_at/founded` 5种走 `relational` | **规划中（2026-09-02）**；见正文 ## 52；不动 `KNOWN_LINK_TYPES`，只补 `TEMPLATES` |
| 53    | History 底层 + note 正排：保全量对话，不直检 history，note 侧车 `provenance→messages.jsonl` 按需回跳 | `inbox/sessions/*/messages.jsonl` 已存但 `note` 无 `provenance`/`source_turns` 落盘，`validator` 不写 | **规划中（2026-09-02）**；见正文 ## 53；检索仍只走 `pages/chunks` |
| 54    | Prompt/模板参照 Codex 重构：补 NO-OP 门控 + 高信号4桶 + Outcome 分流，`abstract/overview` 弱 prompt 加强 | `session-extract-v1.md 142行`扁平无门控，`abstract/ overview 8行`无字面保留/偏好分栏 | **规划中（2026-09-02）**；见正文 ## 54；`read` 不照搬 `read_path.md`，只搬门控文案 |
| 55    | 真矛盾标记（非 `duplicate` 相似）：借 `gbrain facts/classify.ts` 实体桶+`0.95/0.92`+LLM 三分类，`值不同`二筛，人审托底 | 现 `P10.3` 全量500条`cosine≥0.95→duplicate`、无实体桶、无`supersede`、`local` 跳过，无 `值冲突` | **规划中（2026-09-02）**；见正文 ## 55；对标 `gbrain/src/core/facts/classify.ts:3` |




#1–#7 为八期评审痕迹。#8–#22 为先前 08/面试审计。#23–#43 为 2026-08-16 补全。#44–#48 为 2026-08-21 会话追加（十一期）。#49 为 2026-08-23 会话追加。#50 为 2026-08-27 GroupMemBench 全量后追加。裁剪见八期 README §0。下列正文 **与 Spec 冲突时以 Spec 为准**。

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

**TODO**：→ `[specs/八期/P8.1-session-hook-async.md](specs/八期/P8.1-session-hook-async.md)`

**风险**：fail-open 原则——任何挂钩失败不得把 transcript 写入 sources/；失败可观测。

## 2. memory_remember 后台异步化

**现状**：工具执行 = 同步 compileSession（LLM 抽取 + 写盘 + 可能懒蒸馏），实测单次可达 15-18s，阻塞主会话。

**评估**：合理，但**不能 fire-and-forget**。与 #1 共用 JobRunner（`.dfmemory/jobs/`）。

**TODO**：→ P8.1 §4.2–4.5

## 3. 自定义 brain 支持

**现状**：`config.brainId` 覆盖 + `memory_brain create/list` 可用；工具无 per-call brain 参数。

**评估**：部分合理。会话级切换不做。

**TODO**：→ `[specs/八期/P8.5-tool-brain.md](specs/八期/P8.5-tool-brain.md)`

## 4. 抽取 prompt 优化（note 拆太细）

**现状**：compile 抽取粒度由 core `resources/session-extract-v1.md` 决定。

**评估**：合理。只改 core 合同；插件预处理是非目标。P6.6 不得破坏。

**TODO**：→ `[specs/八期/P8.4-extract-granularity.md](specs/八期/P8.4-extract-granularity.md)`

## 5. 懒蒸馏阈值 5 → 3

**现状**：`distill.lazy_min_sources` 默认 5，**已是每仓可配置项**。

**评估**：仓内先配 `distill.lazy_min_sources: 3`。改 core 默认值等 P8.1 异步落地后再开补丁。

## 6. 分层检索建议（全量检索保 recall，分层提 precision）

**骨架（保持不动）**：混层并行召回（三臂 RRF）+ 模型按需回读原文。任何分层不得牺牲 recall。不做系统级级联。

**TODO**：→ `[specs/八期/P8.2-layered-retrieve.md](specs/八期/P8.2-layered-retrieve.md)`

## 7. Skill 层独立抽取 + 按需查找注入

**纠正**：不是会话抽 SKILL.md。skill 仍经 P3.2/P7.2 结晶。本期是查找面 + 注入面，默认 query 剥离 skill。

**TODO**：→ `[specs/八期/P8.3-skill-inject.md](specs/八期/P8.3-skill-inject.md)`

---



## 8. 图谱建图/查询规则密度对齐 gbrain（面试评审发现，未排期）

**结论**：结构同构（四 pass + typed edges + 关系模板 + graph signals，均对齐 gbrain 思路），但规则密度与工程防御是 gbrain 的子集。gbrain 有 BrainBench 数据证明图是承重墙（graph 关 → P@5 ~18；全栈 49.1，**+31.4**，`reports/01` §5.1）。

**差距清单**（对照 `reports/01` §4.2/§5.3–5.5）：


| 项                   | 现状（本仓）                                    | gbrain                                                    | 建议                            |
| ------------------- | ----------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| 动词规则库               | `link-extraction.ts` 默认仅 4 条（决定/产出/负责/属于） | FOUNDED/INVESTED/ADVISES/WORKS_AT 等 + 中文模式（ZH_FOUNDED_RE） | 扩词表 + pack `extraVerbs` 化     |
| page-type 绑定边类型     | 无                                         | media→mentions、image→image_of、meeting→attended            | 按 schema_type 绑定默认边类型         |
| link_kind 细分        | 无（仅 source 字段）                            | v98 加 link_kind                                           | 预留列，低优先                       |
| 批量写入                | 逐条 INSERT                                 | `INSERT ... SELECT FROM jsonb_to_recordset`，17K 页秒级       | 批量写入（图大时收益）                   |
| ReDoS / STOPWORD 防御 | 无                                         | 有（relational recall arm）                                  | 查询解析端补                        |
| seed 置信门控           | 无（子串命中即种子）                                | confidence-gated                                          | 邻接臂种子过滤                       |
| 查询批量回填              | BFS 逐节点 SQL（N+1）                          | batch-hydrate                                             | 路径批量 IN（已在 hydrate 端做，遍历端待合并） |
| 评测佐证                | mini 夹具 12 条                              | BrainBench +31.4 P@5 实证                                   | 关系查询专项夹具                      |


**2026-08-16 锁定：下期做。2026-08-20：Spec** `[P10.2](specs/十期/P10.2-graph-verbs.md)` **ready。** 建议切片见文首「下期」表。先按 P10.2 编码。

---



## 9. 真实 pgvector 落地（vector 列 + HNSW，面试评审发现，未排期）

**现状**（已核实）：pgvector 目前仅做**探测门控**——`postgres.ts` 连接时 `CREATE EXTENSION IF NOT EXISTS vector` 探测可用性；但 `chunks.embedding` 列在 postgres 路径上也是 `BYTEA`（`schema.sql` 两引擎共用），语义臂 `semantic.ts` 拉全量向量在 JS 算余弦，**未使用 vector 类型列、**`<=>` **算子或 HNSW 索引**。PGLite 路径同构。

**差距**（对照 `reports/01` §5.1：gbrain 用 pgvector HNSW 向量臂；`specs/五期/P5.7` 只承诺探测与降级，未承诺真向量加速）：


| 项    | 现状                        | 目标                                                       |
| ---- | ------------------------- | -------------------------------------------------------- |
| 列类型  | `chunks.embedding BYTEA`  | postgres 路径改用 `vector(dims)` 列                           |
| 距离计算 | JS 全量拉取 + 余弦（O(n) 内存/CPU） | `<=>` / `cosine_distance` SQL 算子 + 索引加速                  |
| 索引   | 无                         | HNSW 索引（`hnsw (embedding vector_cosine_ops)`）            |
| 引擎分支 | `SqlClient` 无分叉 SQL       | 两引擎最小 SQL 面分支（P5.7 §3 已留 `pgvector` 标志位）                 |
| 迁移   | —                         | BYTEA → vector 列迁移 + `rebuild-index --embeddings` 兜底（D1） |


**约束**：PGLite 无 pgvector，默认档语义臂**保持** BYTEA + JS 余弦不变（engine parity：同 schema 前提下允许 SQL 分叉，行为须一致）；postgres 无 pgvector 时仍 fail-open 降级。

**2026-08-16 锁定：下期做（B）。2026-08-20 用户：本期不做。2026-08-27 重开。**  
证据：GroupMemBench 摄入后 `semanticArm` 对 ~60926×4096 维 BYTEA 全表扫，首问分钟级、评测 `query` 120s 超时。单机「暴力余弦够用」不再成立。

仍只做 postgres 真 `vector` + HNSW；PGLite 不动（走 #50 JS 热路径）。无 pgvector 仍 fail-open。不进已关账的十期 DoD；下期先写 Spec。

---



## 10. 真模型重排序 + 低置信度过滤（面试评审发现，未排期）

**现状**：`search.tokenmax.rerank` 仅支持 `local`（启发式：查询词在 title/snippet 的命中打分，`rerank.ts`）；LLM/真模型 rerank 是接口预留、kill-switch 默认关。**无低置信度过滤**——语义臂/图臂召回的低分项照常进榜。

**差距**（对照 gbrain `zerank-2` reranker，`reports/01` §5.5）：


| 项     | 现状             | 目标                                             |
| ----- | -------------- | ---------------------------------------------- |
| 重排序   | local 启发式（词命中） | 真模型 rerank（可配置，kill-switch 默认关保持现状）            |
| 置信度过滤 | 无              | 低分/低置信度命中过滤（RRF 融合分阈值或 reranker 分数门）           |
| 预算/降级 | 无              | rerank 失败 → 回退 local → 回退不 rerank（fail-open 链） |


**约束**：默认档零模型不变（rerank 默认关）；`--explain` 的 `rerank` 状态字段已预留 `skipped/local`，需加真模型档位。

---



## 11. 融合后 cosine re-score（面试评审发现，未排期）

**现状**：`fuseHybridArms` 融合即终分，之后只做 signals/hotness/预筛乘子，**无重打分**。

**差距**（对照 gbrain hybrid 管线：RRF → normalize → boost → **cosine re-score（0.7×rrf + 0.3×cosine）** → dedup，`reports/01` §5.2）：


| 项      | 现状  | 目标                                                         |
| ------ | --- | ---------------------------------------------------------- |
| 融合后重打分 | 无   | 对候选集用查询向量与命中向量 cosine 再打分（0.7/0.3 或可配置）                    |
| 时机     | —   | 在 fusion 之后、graph signals/hotness 之前                       |
| 引擎差异   | —   | 需命中 chunk embedding（当前查询侧已有 embedder；注意 embedding off 时跳过） |


**约束**：embedding off 时跳过该步骤（语义臂本就不可用）；不影响无语义权重档。

**2026-08-16 锁定**：做（B）。embedding 可用即跑，**含** `local` 哈希档（收益小也跑）；系数默认 0.7×rrf_norm + 0.3×cosine，可配。时机仍在 fusion 之后、graph signals / hotness 之前。

---



## 12. temporal 趋势检索（面试评审发现，未排期）

**现状**：检索只按 `updatedAt` 做 hotness 时效衰减（`hotness.ts`），**无趋势/回归检测**。

**差距**（对照 gbrain `find_trajectory`：按 (metric,value) 连续对检测回归，新值比旧值低 ≥10% 触发；Drift score = `1 - mean(cosine(emb[i], emb[i-1]))`，`reports/01` §4.6）：


| 项      | 现状                  | 目标                                                         |
| ------ | ------------------- | ---------------------------------------------------------- |
| 指标变化检测 | 无                   | facts/take 的 (claim_metric, value) 时间序列回归检测                |
| 趋势查询   | 无                   | "这个指标最近在恶化吗"类查询入口                                          |
| 时间轴数据  | 事件账本有 `events/` 时间戳 | 需 facts 带 metric/value/period 字段（gbrain v82 已加 event_type） |


**约束**：需要写入侧先沉淀带量纲的事实（当前 `WRITE_FORMAT` facts 无 metric/value 字段，需先改 Spec）；v1 可不做，维持 hotness 兜底。

---



## 13. 真模型 embedding 落地（默认档升级路径，面试评审发现，未排期）

**现状**：`embed/openai.ts` 的 OpenAIEmbedding **已实现**（`embedding.provider: openai` + `OPENAI_API_KEY`）；但默认 `local` 档是**确定性哈希嵌入**（`embed/local.ts`，bigram 哈希 + L2 归一化），语义质量弱于真模型；换 provider/维度变化已有 `embeddingMetaMismatch` 检测（`hybrid.ts:69`）拒绝陈旧向量，需 `rebuild-index --embeddings`。

**差距**（对照 gbrain 默认即真 embedding + pgvector HNSW；`reports/01` §5.1）：


| 项       | 现状                                   | 目标                                                                               |
| ------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| 默认档语义质量 | local = 确定性哈希                        | 本地可跑的真模型嵌入（如 ONNX/transformers.js 类，离线、无 API key）作为 local 档升级；或至少文档化 openai 升级路径 |
| 升级体验    | 手动改配置 + `rebuild-index --embeddings` | init/CLI 一键切换 + 自动重建提示（meta 检测已就绪）                                               |
| 文档      | 无升级指引                                | 写清 provider=local（哈希，保底）/ openai（真模型，需 key）的选择与重建步骤                              |
| 索引加速    | 无（JS 余弦 O(n)）                        | 已在 **#9**（pgvector HNSW）覆盖，不重复                                                   |


**约束**：默认零依赖离线不变（不能默认联网）；`local` 档改造后须保持确定性、可复现、无网络；相关测试（P21a-05 等）须保持绿。

---



## 14. content_hash 未归一化（08 §5.3 审计发现，未排期）

**现状**：`sync.ts:90` 直接用 `sha256Hex(raw)` 对**全文**（含 frontmatter）哈希。设计 §5.3 明确要求："hash 应对语义稳定字段归一化（**至少剔除纯时间戳型 frontmatter，如** `captured_at`），避免「每次 capture 必变 hash」"。当前 frontmatter 含 `created_at` 等时间戳 → **同一内容每次写入 hash 必变 → 索引幂等短路失效，重复分块/重嵌入**。

**目标**：hash 计算时剔除时间戳类字段（白名单式保留语义字段，如 title/body/schema_type/links/facts/aliases 等）或对 frontmatter 做稳定化序列化。

**约束**：改动须保证「内容语义未变 → hash 不变」且「内容变了 → hash 变」两个方向都成立；现有 M3 系列测试（hash 短路）须保持绿；与 P5.1 余弦去重（enrich 层）互补，不冲突。

---



## 15. source 解析链 7 层只实现 3 层（08 §4.2 审计发现，未排期）

**设计**：`--source flag → env → .dfmemory-source dotfile → 路径前缀匹配 → brain 级 sources.default → sole_non_default（单 source 自动路由）→ 字面 'default'`，7 层。

**现状**（`cli/src/context.ts:30` + 各命令 `o.source ?? ctx.sourceId`）：仅实现 **--source flag → env（DF_MEMORY_SOURCE）→ brain.yml sources.default** 三层。注意：`createBrain` **创建了** `.dfmemory-source` **标记文件**（`repo/brain.ts:96-99`），但**没有任何代码读取它**——文件是死配置。sole_non_default 自动路由也无。

**目标**：补齐 dotfile 读取层 + sole_non_default 层（或明确裁剪并从创建逻辑中移除死文件，二选一，避免死配置残留）。

---



## 16. 索引表缺口：facts / event_ledger（08 §5.2 审计发现，未排期）

**设计索引清单**：`pages / chunks / links / facts / experiences / skills / entity_registry / event_ledger / search_cache / change_log`。`schema.sql` 实际只有：pages / chunks / entity_registry / links / search_cache。


| 表                    | 现状        | 说明                                                                                                       |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `facts`（hot memory）  | 无表        | facts 只在 frontmatter 文件里；P5.1 dedupe 读文件而非索引；查询不消费 facts 索引                                              |
| `event_ledger`       | 无表        | `events list` 直接扫 `events/YYYY-MM/ledger.jsonl`（`ledger.ts`）；设计另写形状 `{slug}.jsonl`，实现为单文件 `ledger.jsonl` |
| `change_log`         | 无表（文件版在）  | `memory_diff.jsonl` 文件实现可用（`changes` 命令），可视为裁剪                                                           |
| `experiences/skills` | pages 行承载 | syncAll 将 experiences/skills 的 md 按 page 索引（path 过滤）——**设计收敛，可接受**                                       |


**目标**：facts/event_ledger 按需补索引表（时间线/溯源/冲突检测用），或显式声明"文件即索引"裁剪并更新 08。

**2026-08-16 锁定：不做。** 不建派生表。facts 只在 frontmatter；event_ledger 继续扫 `ledger.jsonl`。08 改为「文件即索引」裁剪。#12 趋势扫 md，不依赖本表。

---



## 17. 矛盾分类简化（08 §8.3 审计发现，未排期）

**设计**：矛盾分类 = cosine ≥0.95 快路径判 DUPLICATE（零 LLM）→ LLM 三分类 duplicate/supersede/independent → LLM 失败时 cosine ≥0.92 兜底 DUPLICATE → 结果写 `contradictions.md`。

**现状**：dream phase 4 只做**同文件内 facts 文本重叠启发式**（`dream/runner.ts:147-167`，去空白小写比较 + event_type 同型），跨文件/近似语义矛盾不检测；无 cosine 快路径、无 LLM 三分类、无降级。

**目标**：至少补 cosine 快路径（跨文件近似事实对）+ 冲突写 `contradictions.md`；LLM 三分类按 P7.x 的 `complete()` 接入；降级链按设计。

**2026-08-16 锁定：下期。2026-08-20：锁 B，Spec** `[P10.3](specs/十期/P10.3-contradictions.md)`**。** 无 facts 表（#16 不做）则扫 md；`local` 哈希档跳过跨文件 cosine。产出只写 `contradictions.md`，不接 hybrid。C（LLM 三分类）不做。

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

**现状（2026-08-26）**：L0 `captureNode` / compile `captureWrite` / `importNode` 同写事务 append `memory_diff op:create` + ledger `node_created`。`memory changes` 可见。`revert create` 仍 unsupported。

**目标**：capture 落盘后在单写事务内 append `op: create`（或 node_created，`reports/12` 已指出事件账本缺 node_created——同根问题）；保证 `changes` 命令能审计 L0 写入。

**2026-08-16 锁定：下期做 C。2026-08-26：P11.7 done。** 与 #37 同一写事务：`memory_diff op:create` + `node_created`。不另建 ledger 表。**Spec** `[P11.7](specs/十一期/P11.7-l0-audit.md)`。

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

**2026-08-16 锁定：下期，与 #32 同一 Spec。2026-08-20：**`[P10.4](specs/十期/P10.4-query-observe.md)` **ready。** query log 记 latency + 各臂 evidence；observer 出分布。

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

**2026-08-16 锁定：下期，与 #22 同一 Spec。2026-08-20：**`[P10.4](specs/十期/P10.4-query-observe.md)` **ready。** 补齐 `query_plan`、`searched_directories`、分母/阈值级 `score_details`。

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

**设计**：08 §15 `/evals` LongMemEval；`[reports/10](reports/10-公开记忆Benchmark调研.md)` 把 LongMemEval_S 列为 P0、HaluMem-Medium 为 P1。

**现状**：P5.6 = `eval:mini` + `eval:distill` + LoCoMo **仓内 fixture**。无 LongMemEval / HaluMem adapter。

**评测发现（2026-08-21）— 信息更新（Update）能力弱**：

- **现象**：`halumem-official-v1` 预跑（Martin Mark `2f1f897e…`，max_sessions=5，4/5 compile）；**Update Correct 0/8**（官方 judge 全判 Omission）；同期 Integrity **85.6%**、QA **58.3%** — 写入/检索尚可，**变更记忆几乎不会**。
- **Receipt**：`evals/receipts/2026-08-21T09-51-35-376Z-adapter-halumem.json`
- **待查/待做**（未排期）：
  - compile 热路径 **L0 ADD-only**（D17）是否导致旧 fact 不被替换/标记过期
  - update 验证仅 `hybridQuery` top_k=10 + 全 L0 列表 judge，是否检索不到「更新后」表述
  - 是否需要 **patch/merge** 写路径或 session 内显式 update 提取（不破 P6.6 / D17 前提下先改 Spec）
- **简历/对外**：主指标写 Integrity + QA；**勿夸大 Update**，直至上述项有改进 receipt。

**2026-08-16 锁定：下期。范围未锁。**  
**门闩**：下期开工前必须再问用户（上哪些 adapter、是否进 CI、与仓内 mini/LoCoMo 的关系）。禁止默认按 reports/10 把 LongMemEval_S 当九期/下期必做全量。

---



## 36. `@lhdrc/core` npm publish（P4.2 A，未排期）

插件 `package.json` 现为 `file:../lhdrcMem/packages/core`。未 publish 不阻塞八期代码 DoD，但阻塞「别人 `dsh plugin add` 不靠本地 path」。

**2026-08-16 锁定：不做。** 下期若做 #34 `memory upgrade`，必须先重开 publish，否则 upgrade 无 registry 可问。

---



## 37. 事件账本缺 `node_created`（08 §4.5，未排期）

**设计**：capture/update 进不可变事件流。

**现状（2026-08-26）**：L0 `captureNode` / compile / `importNode` 同事务写 `memory_diff op:create` + ledger `node_created`。`revert create` 仍 unsupported（D17）。

**2026-08-16 锁定：下期做 C。2026-08-26：P11.7 done。** 与 #20 捆绑。**Spec** `[P11.7](specs/十一期/P11.7-l0-audit.md)`。

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



## 44. hotness 学 OpenViking：freq × recency（2026-08-21 会话）

**对照**：`[reports/04](reports/04-openviking-调研报告.md)` §5.3；`memory_lifecycle.py`：`hotness = sigmoid(log1p(active_count)) * exp(-decay*age)`（OV 半衰期默认 7 天）。本仓现网 P9.3：只用 `pages.updated_at` 做 `exp(-ln2*age/30)`，再 `score = rel * (1 + 0.15 * h)`。

**现状**：无访问次数。P10.4 `query.jsonl` 只记 `hitCount` / `avgScore` / latency / evidence 臂占比，**不记终榜 path**，无法还原 active_count。

**2026-08-21 锁定：下期做，第一步只加频率项。**


| 锁   | 做法                                                                             |
| --- | ------------------------------------------------------------------------------ |
| 公式  | `h = freq * recency`；`recency` 维持现网指数衰减；`freq = sigmoid(log1p(n))`             |
| 零计数 | `n=0` 或尚无计数 → **freq=1**（与现网同分序，P9.3 夹具不炸）                                     |
| 融合  | 仍 `score = rel * (1 + α * h)`；**α 默认 0.15**；半衰期默认 **30 天**（可配，不强制改 7）          |
| 计数  | hybridQuery **终榜 path** 累加（读一次 +1）；须补 query log 或独立 counter；失败 fail-open 当 n=0 |
| 验收  | 无计数：与现网序一致；有计数：同相关度下 n 大者更前；**旧文档标题全命中仍压过新文档无关**（P9.3 回归）                      |


**明确不做（本项）**：加法 0.45；把 α 拧大当「更新语义」；按访问删除/归档；LLM；把 contradictions 乘进 hotness；改三臂 RRF。

开工先改 Spec，再改 `retrieve/hotness.ts` + query log。**Spec** `[P11.2](specs/十一期/P11.2-hotness-freq.md)`。

---



## 45. 意图→目录先验（2026-08-21 会话）

**对照**：OpenViking「召回是范围选择」；本仓 `classifyIntent` 只改 RRF 权重；`directory_prefilter` 事后重排且默认关；`thinkQuery` 先全仓再分桶。HaluMem/QA 即使 top_k=20 仍 miss。

**2026-08-21 锁定：十一期做。** 先按意图缩到 `experiences/` / `entities/` / `issues/` 等 pack 路径，证据不足（命中少 / 低于 fused_min / evidence 薄）再扩全仓。`query_plan` 必须能看到 `scope:` / `expand:global`。

**守 #6**：禁止无回退级联。CLI `search.scope_first` 默认 **false**；`thinkQuery` 默认开。不做 LLM 意图、不做 HierarchicalRetriever 递归下钻、不把前端「设计偏好」写进 core。

**Spec** `[P11.1](specs/十一期/P11.1-scope-route.md)`。

---



## 46. 写入 duplicate ≠ update（2026-08-21 会话）

**现象**：HaluMem-official Update Correct 0/8 全 Omission；Integrity 仍可。提取合同「Already in the knowledge base 不要再抽」+ P5.1 余弦 ≥0.95 跳过，会把「同一主语、新宾语」当成重复丢掉。

**2026-08-21 锁定：十一期做。** prefetch 命中的是旧值 → 必须再写新 L0 item；余弦近但数字/地点/专名不同 → **不是 duplicate**。可带 `supersedes` / 用已有 `at`/`period`。**不** patch 旧 `sources/` md，不破 D17。

**Spec** `[P11.3](specs/十一期/P11.3-update-write.md)`。

---



## 47. 旧事实检索降权（2026-08-21 会话）

**对照**：P10.3 只写 `contradictions.md`、**不接 hybrid**；正文写明「过期事实降权另开 Spec」。GBrain consolidate 标 `consolidated_into`、永不 DELETE。

**2026-08-21 锁定：十一期做。** 跨文件 duplicate 对里较旧 path **乘子降权**（不丢出终榜）。无 contradictions 文件 fail-open。`local` 哈希档无跨文件对则本项空转。 **禁止** LLM 三分类（#17-C）、禁止乘进 RRF 当硬过滤、禁止删 L0。

**Spec** `[P11.4](specs/十一期/P11.4-stale-demote.md)`。

---



## 48. 实体槽位 patch（2026-08-21 会话）

**对照**：OpenViking 字段级 `merge_op`（topic immutable / content patch）。本仓 pack `note: patch` 不消费；`entity link-facts` 只 append。#42 已裁通用 `updateNode`。

**2026-08-21 锁定：十一期做。** 仅 **实体 facts** 对同一槽位（同一主语当前值）允许 patch；L0 note/decision 仍 ADD-only。`note: patch` 在 pack 里注明「L0 不读」。不做两实体合成之外的 source 覆盖写。

**Spec** `[P11.5](specs/十一期/P11.5-entity-slot.md)`。

---



## 49. 冲突人工审阅 + 失效软删（2026-08-23 会话）

**现状（2026-08-26）**：`memory contradiction list|resolve`；keep a/b 将失效侧 `facts[i].status=superseded`；sidecar `contradictions-reviews.jsonl` 抗 dream 覆盖；索引去掉 superseded 字面量。P11.4 默认仍关。

**2026-08-23 锁定：做。2026-08-26：P11.6 done。**

```
dream 标记 → 每对 status=pending
人工裁决   → keep_both | 留 A | 留 B（禁止 LLM 终审）
失效一侧   → fact 级软删（status=archived/superseded）；不 rm；检索排除
未审       → 两侧都可检索，不自动乘 0.85
```

- 优先 fact 级，禁止因一条过期 fact 归档整篇 note。  
- 不 patch 旧 md 正文。  
- P11.4 默认关；裁决写入 sidecar `contradictions-reviews.jsonl`。

**Spec** `[P11.6](specs/十一期/P11.6-contradiction-review.md)`。

**明确不做**：#17-C LLM 三分类当终审；dream 自动判谁过期；物理 `--purge`。

---



## 50. main 嵌入 / 语义臂热路径（2026-08-27，GroupMemBench 后）

**2026-08-28：P12.1 done。** Spec `[specs/十二期/P12.1-embed-hotpath.md](specs/十二期/P12.1-embed-hotpath.md)`。

**原状**：`semanticArm` 对全部 `chunks.embedding` 做 JS 余弦；打分 SQL 还拉 `c.text` / `p.title`；`bytesToFloat32` 拷成 `number[]`；`rebuild-index --embeddings` 失败即整段作废；兼容网关 500 不重试。

**已落地**：打分只读 embedding；Float32 视图；`--pending-embeddings`；openai-compatible 429/5xx 重试；进程内按仓缓存。`syncPage` 嵌入与 page 分事务。

**不替代 #9**：仍是 O(n) 扫描变便宜，不是 ANN。

**目标（main，PGLite 默认档也要）**：


| 项      | 做法                                                                   |
| ------ | -------------------------------------------------------------------- |
| 打分 I/O | 只读 `path + embedding`；winner 再取 text 做 snippet                       |
| 数值     | BYTEA 上 `Float32Array` 视图，避免每条 `number[dims]`                        |
| 续跑     | `rebuild-index --pending-embeddings`：只填 `embedding IS NULL`，不清 pages |
| 网关     | openai-compatible embeddings 429/5xx 重试                              |
| 进程内    | 长驻 query 可按 `repoRoot` 缓存向量；一次性 CLI 进程退出则无增益                         |


**不替代 #9**：这是 O(n) 扫描变便宜，不是 ANN。HNSW 只在 postgres + pgvector。

**约束**：先改 Spec（M3 / P2.1a 语义臂）再合 main；D1 索引可丢。评测用 `query_loop` 不必进 CLI 默认路径。

---



## 51. BM25 文章级倒排优化（2026-09-02 规划，文章级返回不变）

**定位**：只动 `pages` 的 BM25 臂（`packages/core/src/retrieve/query.ts:59 bm25Query` / `packages/core/src/index/sync.ts:105 syncPage` / `packages/core/src/index/schema.sql:3`），`chunks` 仍仅服务语义臂 `semantic.ts:47`；返回仍为文章级 `QueryHit{path,title,score,snippet}`，不改切块/语义/图谱管线。

**现状**：`fts_title/fts_body/title_ngrams/body_ngrams TEXT` + 每查 `to_tsvector('simple',…)` 实时 `ts_rank` 全表扫（无 `GIN`）；`bigrams.ts:3` 去空白后二字硬切产跨词噪音（`试策/略调`）；仅 `query.ts:75` 权重 `3.0/1.0/2.0/0.8 + position` 无长度归一；`code/diff/##` 未统一清洗，`link-extraction.ts:52 stripCodeBlocks` 仅图谱用。

| 优先级 | 规划 | 落点 | 验收 |
|---|---|---|---|
| P0-1 | 物化倒排：`GIN(to_tsvector('simple',coalesce(fts_title,'')))` + `fts_body`，或存 `tsvector` 列增量更 | `schema.sql` + `sync.ts:145 titleNgrams/bodyNgrams` | `EXPLAIN` 走 `Bitmap Index Scan`；万级 `bm25Query` P95 < 100ms |
| P0-2 | 统一清洗 `cleanForIndex(text)`：复用 `stripCodeBlocks` + 去 `[]()/#|>` + NFKC/lower + 空白归一，`indexBodyText` 之后再洗才写 `fts_*/bigrams` | `sync.ts:57 indexBodyText` + `query.ts` | `M3-06` 中文 + `M3-01` 回归绿；`code` 块不抬分 |
| P1-1 | bigram 去噪：过滤跨词 bigram（频次/词典） | `ngrams.ts` | `title_ngrams` 无 `试策/略调`；`eval:mini` 精排↑ |
| P1-2 | 长度归一：`score /= len^β` 或 BM25 `k1/b` | `query.ts:75` | 长文不再垄断 top1（`P93-02` 同款用例） |
| P2 | 短语：`phraseto_tsquery` 或 `position` 倒排加分 | `query.ts` | `“固定 3 次”` 带空格仍命中 |

**不做**：自建 posting list、切块级 BM25、`jieba` 重分词、把清洗结果写入 `content_hash`（`content-hash.ts:49` 白名单外）、把 `chunks` 拉进 BM25。

**顺序**：P0-2 清洗 → P0-1 GIN → P1 → P2；先过 `bun test packages/core/tests/m3_index.test.ts` + `eval:mini` 再动下一档。拟收成 `specs/十三期/P13.1-bm25-article.md`（待排期，先记账）。

## 52. 图谱边类型建≡检索闭环（2026-09-02 规划，独立于 P10.2）

**问题**：`graph/link-extraction.ts:20 KNOWN_LINK_TYPES` 10种 + `DEFAULT_VERBS:35` 8正则（+ pack `extra_verbs` `index/sync.ts:25`）已能建全量 `links`（`schema.sql:43`）；但 `retrieve/graph.ts:22 TEMPLATES` 仅覆盖 `mentions/works_on/references/works_at/founded` 5种，`decided/produced_by/belongs_to/invested_in/advises` 永远走 `collectAdjacencySeeds:127` 邻接兜底，不走 `relational` 精准臂 `graphArmDetailed:267`。

**目标**：建≡检索闭环，不新增 `KNOWN_LINK_TYPES`，只补检索侧。

| 缺口 | 补的模板（中英各一） | 落点 |
|---|---|---|
| `decided` | `谁决定了(.+)` / `who decided (.+)` | `graph.ts:22 TEMPLATES` |
| `produced_by` | `谁产出了(.+)` / `who produced (.+)` | 同上 |
| `belongs_to` | `(.+)属于(.+)` / `(.+) belongs to (.+)` | 同上 |
| `invested_in` | `谁投资了(.+)` / `who invested in (.+)` | 同上 |
| `advises` | `谁是(.+)顾问` / `who advises (.+)` | 同上 |

`hitsFromSeeds:161` 已支持 `type=$3` 过滤，`extra_verbs` 自动透传；`signals.ts` 暂不按 `type` 加权，保 fail-open。

**不做**：新增边类型、改 `DEFAULT_VERBS`、动 `signals/prefilter/rrf`、page-type 绑定边。

**验收**：`p10_graph_verbs.test.ts` 各补 1 例 `relational` 命中；`graphArmDetailed` 对 10 种 verb 均可 `mode=relational`；`eval:mini` 图臂不回退。

拟收成 `specs/十三期/P13.2-graph-verb-complete.md`（待排期，先记账）。

## 53. History 底层 + note 正排（2026-09-02 规划，`Memory 优化.md:11 整体优化`）

**问题**：`inbox/session.ts:98 archiveSession` 已落全量 `messages.jsonl`（`Turn{role,text,at}`），但 `compile/session.ts:288` 抽 `note` 时 `session-extract-v1.md:34 source_turns` 不落 `validator.ts:162` frontmatter，`provenance` 缺失，LLM 无法按需回跳原文核验。

**目标**：`history` 底层保原始不改（不进 `pages/chunks` 索引），`note` 正排指向 `history`，检索仍只走 `note/experience`。

| 项 | 做法 | 落点 |
|---|---|---|
| 建 | 复用 `archiveSession/appendTurnsToSession` + `compile/window.ts` 滑动窗口，不新增 history 写口 | `inbox/session.ts` |
| 指 | `note` 侧车 `history_index.jsonl` + 可选 frontmatter `provenance:{session_id, turns:[1,2], history_ref:"inbox/sessions/<id>/messages.jsonl#turn2-3"}`，存 `turn_index` 非 `byteOffset` | `write/capture.ts:86` / `validator.ts` 白名单外（不进 `content-hash.ts:20`） |
| 读 | `memory read <path> --with-history` 或 `memory history read --session <id> --turn 2` 按需 `cat messages.jsonl`，`--explain` 透 `provenance` | `node/read.ts:24` + CLI |
| 检 | `bm25Query/semanticArm` 永远不扫 `inbox`，`query.ts:72` 保持文章级 | `retrieve/hybrid.ts` |

**不做**：把 `transcript` 整篇当 `L0`、`fts_*/bigrams` 吃 `history`、用 `byteOffset` 替代 `turn_index`、`content_hash` 吃 `provenance`。

拟收成 `specs/十三期/P13.3-history-provenance.md`（待排期，先记账）。

## 54. Prompt/模板参照 Codex 重构（2026-09-02 规划，`Memory 优化.md:20 优化note的prompt和模板`）

**问题**：`resources/session-extract-v1.md 142行` 仅 `decision/lesson/note` 类型合同 + 少量 few-shot，无 `stage_one_system.md:28 NO-OP Gate / 48 High-signal 4桶 / 99 阅读顺序 User>Tool>Assistant / 150 Outcome triage / 304 evidence->implication`；`abstract-v1.md/overview-v1.md` 各 8 行，无字面保留与偏好分栏，摘要易丢数/名；`codex-rs/ext/memories/templates/memories/read_path.md:17` 的渐进披露（`memory_summary→MEMORY→rollout` 4-6步）不能直套 `node/read.ts:24 L0/L1/L2` CLI。

| 规划 | 搬运 | 落点 |
|---|---|---|
| 门控 | 抄 `Will future agent act better?` 四条空转判 + `NO-OP {"items":[]}` | `session-extract-v1.md` 首部 |
| 信号 | 4桶：稳定偏好/高杠杆捷径/任务映射/环境证据；`Preference signals` 原话保留 `when user said "<quote>" -> future default` | 同上 |
| 分流 | `success/partial/fail/uncertain` 据 `fail` 多写 `Failures` 少写复现 | 同上 |
| 字面 | `Wording-preservation: keep original nouns/commands` 取代泛泛总结 | `abstract/overview-v1.md` 加 `preserve original wording before compress` |
| 读 | `read_path.md:12-16` 的 `Skip ONLY self-contained / 命中 workspace即查` 译成 `shouldQueryMemory` 门控文案与 `query --explain` 的 `query_plan`，`read` 接口不动，仅增 `--with-history` | `retrieve/query-triggers.ts` + CLI help |

**不做**：全量两阶段 `raw_memories→MEMORY.md` 归并、`read` 改成 Codex `search/list/read` 三工具、按项目训专属模型。

拟收成 `specs/十三期/P13.4-prompt-codex.md`（待排期，先记账）。

## 55. 真矛盾标记（2026-09-02 规划，借 `gbrain/src/core/facts/classify.ts:3`）

**对标**：`gbrain` Hot Memory `classifyAgainstCandidates:68` 决策树：`①实体桶 k=5 候选（`engine.findCandidateDuplicates:1885` 必带 `entity_slug`）②`top cosine≥0.95→duplicate` 快路径 `cheapThreshold` `③LLM `duplicate|supersede|independent`（`CLASSIFIER_SYSTEM:146` `<existing id>` 包 DATA）④失败回退 `≥0.92→duplicate` 否则 `independent`；`insertFact:1760` 串行锁 + `expired_at+superseded_by` 软链；抽取侧 `extract.ts:165` 已打 `kind/notability/metric/value`。

**本仓差距**：`dream/runner.ts:222` `500条` 无实体桶全量 `O(n²)`，`cross-file` `local` 跳过，`P10.3` `duplicate` 即结论无 `supersede`，无 `值不同` 二筛（`dedupe.ts:40 isObjectValueConflict` 仅 `Dedup` 用）。

| 规划 | 落法 | 对标 |
|---|---|---|
| 桶 | `倒排 fts + links + entity_registry` 按 `entity_slug` 分桶，`k=5` cap（`findCandidateDuplicates` 同参），`source_id` 隔离 | `classify.ts:3①` + `engine:1885` |
| 快路径 | 桶内 `cosine≥0.95→duplicate`（`cheapThreshold`），`Float32` 视图，跳 LLM | `classify.ts:92` |
| 值冲突 | `isObjectValueConflict + 否定词` 二筛：`值不同→ supersede候选`，`值同→ duplicate`，跨值 `NY=New York` 查 `alias` | 本仓 `dedupe.ts` 复用 |
| LLM | 灰区 `0.92-0.95` 批量10对 `complete()`，`system: You decide duplicate/supersede/independent...<existing> DATA`，严格 `{"decision":...,"matched_id":...}` + 炸 fence 去噪，`refusal/timeout→0.92回退` | `classify.ts:105 chat` + `parseClassifierJson:179` |
| 落盘 | `contradictions.md ##cross-file` 标 `contradiction supersede a->b` + 预填 `facts.supersedes`，`contradiction/review.ts:73` 人审 `keep a|b` 才 `superseded` 入索引剔除 `sync.ts:54` `*0`；`expired_at+superseded_by` 双链留审计 | `engine.insertFact:1758` + `facts superseded_by` |
| 增量 | `dream --phases 4` 仅新 `facts` + 同桶邻居增量嵌，`local` 档走规则分支不进 LLM | `gbrain` 实体锁增量 |

**不做**：全量 `O(n²)` `LLM` 每对判、`local` 强行 `0.95`、`k>5`、把 `supersede` 自动 `purge` 整篇。

拟收成 `specs/十三期/P13.5-contradiction-true.md`（待排期，先记账）。

---

## 备注

- **本次重审（2026-08-16）**：#23–#43 补 08 里「有章节、无 Spec 主人」的项；已落地（混合检索骨架、graph signals、search_cache、分层 sidecar、DSH 闭环等）不重复列。  
- **2026-08-21**：#44–#48 追加，收成十一期 P11.1–P11.5。  
- **2026-08-23**：#49 追加（冲突人工审阅 + 失效软删；修订 P11.4）。  
- **2026-08-26**：#49 → P11.6 done；#20+#37 → P11.7 done。
- **2026-08-27**：重开 #9（postgres vector+HNSW）；追加 #50（main 嵌入/语义臂热路径，PGLite 也要）。GroupMemBench 6 万 chunk 暴力余弦不够用。
- **先前审计**：#8–#22；#8 含 §7.5 NER 类型链接，不另开号。
- **明确不做 / 后置** 仍占行，避免再被当成「AI 漏拆」。
- 推进任一项：先改对应 Spec/08，再改代码。
- **下期项** 以文首「下期」表为准；会话里说「下期再做」必须回写该表，不能只留在对话。

