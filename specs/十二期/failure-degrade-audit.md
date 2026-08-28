# 失败与降级缺陷账本（现网审计）

> **性质**：缺陷清单，不是 Spec。不改行为；修复须另开 Spec。  
> **范围**：`packages/core` + CLI。对照 P6.1 / P9.2 / P9.8 / P8.1 fail-open / `00-conventions` 错误码。  
> **审计日**：2026-08-28。P12.1 已修部分写入/嵌入续跑；下表仍按**审计时逻辑**记录，已修的标「P12.1 已缓解」。  
> **原则（2026-08-28 锁定）**：错误包装给**使用记忆的宿主 agent**（工具 JSON / 注入短句），**不是**仓内做抽取的 `complete()`。见 [`P12-error-to-model.md`](P12-error-to-model.md)。

故意的 fail-open（Spec 允许，不当作 bug，除非撒谎或不可观测）：

| 行为 | 依据 |
|---|---|
| query 语义臂：openai 缺 key → 哈希 + `embedding_fallback` | P9.2 读路径 |
| `--explain` 无时 BM25+图仍返回 | P9.2 / P2.1a conservative 降级 |
| graph 无种子 / 无表 → 空臂 | P3.1 |
| search_cache 读写失败不影响 query | 实现注释 |
| Iron Law / back-link 子步骤失败不回滚主节点 | P9.7 |
| remember 无 key 且未 `--no-extract` → job **failed** `E_DISABLED`，不写 L0 | P9.8；**不是** fail-open |
| postgres 无 pgvector → 语义臂空 + warn，BM25 仍可用 | P5.7（探测失败关臂） |

---

## 高

### F-01 postgres 已连上但仍跳过 BYTEA 余弦

- **位置**：`retrieve/semantic.ts`：`engine === "postgres" && !db.pgvector` → `return []`  
- **现状**：P5.7 探测不到 `CREATE EXTENSION vector` 就关语义臂。列类型仍是 BYTEA，JS 余弦在 PGLite 上完全能跑。  
- **缺陷**：无扩展 ≠ 不能算距离。用户付了 Postgres 进程，语义臂却比 PGLite 更差（直接空）。warn 只打一次，之后静默。  
- **方向**：无 pgvector 时走与 PGLite 相同的 BYTEA+JS 路径（P12.1 热路径）；有扩展再走 #9。

### F-02 query 热路径吞掉 embedding HTTP 失败

- **位置**：`retrieve/hybrid.ts` `embedder.embed([q])` / `semanticArm` 外层 `catch {}`  
- **现状**：429/5xx/JSON 错 → 语义臂当「不可用」，query **退出 0**，无 `embedding_fallback`（那只在缺 key 的 factory 降级上）。用户以为 balanced 含语义。  
- **缺陷**：与 P9.2「缺 key fail-open 哈希」不是同一条路；出网失败既不降级哈希、也不报 `E_INDEX`。P12.1 给 **写路径** embeddings 加了 429/5xx 重试，**读路径 query embed 仍一次失败即关臂**。  
- **方向**：重试与写路径对齐；耗尽后 `--explain` 必须有 `semantic:error` / 可选 fail-open 哈希；默认至少可观测。

### F-03 `rebuild-index --embeddings` 先 clear 再失败

- **位置**：`index/rebuild.ts`（`--embeddings` 分支仍 `clearBrainIndex` + `syncAll`）  
- **现状**：清掉旧索引后中途网关挂 → 部分 pages 有向量、其余无。再跑 `--embeddings` **又 clear**。  
- **P12.1 已缓解**：`--pending-embeddings` 不清、只填 NULL；`syncPage` 把 embed 移出 page 事务。  
- **仍缺**：默认 `--embeddings` / 无旗标的 rebuild 仍先 clear；help 不够强调「中断后改 pending」。无自动从 `--embeddings` 失败切到 pending。  
- **方向**：文档+CLI 提示；或 `--embeddings` 失败退出码带 `hint: --pending-embeddings`。

### F-04 缺 embedding key：读哈希、写空向量、rebuild 严格，三角不一致

- **位置**：`embed/factory.ts` `strict`；`index/hooks.ts` 非 strict；`rebuild --embeddings` strict  
- **现状**：  
  - query：缺 key → 哈希语义臂（P9.2）  
  - capture hook：缺 key → 哈希写入，meta 记实际 `local`（P9.2 锁定）  
  - `rebuild --embeddings`：缺 key → `E_DISABLED`  
  - `OpenAIEmbedding.resolveApiKey`：抛 **`E_USAGE`**（不是 `E_DISABLED`），与 LLM 缺 key 的 `E_DISABLED` 不一致  
- **缺陷**：同一「没 key」三套码、两套错误码。init 默认 `embedding.provider: openai` 却不提示设 env。  
- **方向**：错误码统一 `E_DISABLED`；`init` / `config` 列出缺的 key（见配置方案）。

---

## 中

### F-05 LLM `complete` 无重试；embedding 将有、chat 没有

- **位置**：`llm/openai.ts` 单次 `fetch`  
- **现状**：兼容网关 502 → `E_LLM`，inbox `failed`，不写 L0（P6.1 正确）。抖动一次就整段会话作废。  
- **方向**：与 P12.1 embeddings 同一套 429/5xx 退避；4xx 不重试。

### F-06 `llm.extract` / `kill_switch.extract` / `--extract` / `DF_MEMORY_EXTRACT` 四门闩

- **位置**：`write/enrich.ts`、`cli/commands/capture.ts` `envExtractEnabled`、`llm.kill_switch.extract`  
- **现状**：init 模板 `llm.extract: false`。capture 要 LLM 抽 facts 还要 CLI 旗标或环境变量。`kill_switch.extract` 又是第四道。用户改 `llm.provider=openai` 以为 capture 会抽，不会。  
- **方向**：配置 CLI 用一张表画出「谁真正调 complete」（见 P12-config-cli）。考虑废弃重复门闩或标明优先级。

### F-07 `llm.distill: false` 与 `kill_switch.distill` 重复；`isCompileEnabled` 不读「正开关」

- **位置**：`llm/factory.ts` `isDistillEnabled` 看 `cfg.distill`；`isCompileEnabled` **只**看 provider + kill_switch，没有 `llm.compile` 键  
- **现状**：compile 无法在 yml 里「关编译、开蒸馏」除了 kill_switch。`llm.distill` 是正开关，compile 只有杀开关。  
- **缺陷**：配置模型不对称，用户无法从 yml 直觉「哪里启用 llm」。

### F-08 未知 `llm.provider` 静默变成 `off`

- **位置**：`repo/config.ts` `parseLLMProvider`：非 `off|openai` → `off`  
- **对照**：未知 `embedding.provider` → `E_USAGE`（P9.2）  
- **缺陷**：打错字 `opena` 表现为「没配 LLM」，不是用法错误。

### F-09 hybrid 多处空 `catch`：图臂、signals、hotness 计数、cache

- **位置**：`hybrid.ts` graph / `applyGraphSignals` / `readHitCounts` / cache  
- **现状**：图 SQL 失败 = 空图臂，query 仍 0。合理 fail-open，但 `--explain` 常看不出「图臂异常」vs「无种子」。  
- **方向**：`query_plan` / explain 增加 `graph:error`（P10.4 已有 graph_mode=empty，不足以区分错误）。

### F-10 窄搜范围选择失败直接 expand（吞异常）

- **位置**：`hybrid.ts` `runScopedHybrid` 窄搜 `catch { expand = true }`  
- **现状**：符合 #6 必须 fallback，但窄搜因 **E_INDEX** 失败与「证据不足」都变成 `expand:global`。  
- **方向**：explain 区分 `expand:error` vs `expand:thin`。

### F-11 Job 超时与 LLM 仍在飞

- **位置**：`jobs/runner.ts` 注释写超时后不让结果写盘；LLM `fetch` 无 AbortSignal  
- **现状**：`E_TIMEOUT` 不写 L0（P8.1），但网关侧请求可能跑满 60s（`COMPLETE_TIMEOUT_MS`）。  
- **方向**：complete/embed 接 AbortSignal。

### F-12 capture / remember 异步失败可观测性

- **位置**：P9.8 默认入队；`memory job status`  
- **现状**：CLI 默认 `accepted`。无 key 的 remember → 稍后 `failed E_DISABLED`。用户不当场看到「请设 OPENAI_API_KEY」。  
- **方向**：enqueue 前预检缺 key/provider=off，accepted 响应带 warning；或 config CLI `doctor`。

---

## 低

### F-13 `OpenAIEmbedding` 缺 key 用 `E_USAGE`

- 见 F-04。LLM 用 `E_DISABLED` + `skipped_reason: missing_key`。

### F-14 PGVECTOR_WARN 只 warn 一次（模块全局）

- 多仓/测试互相污染；长驻插件只说一次。

### F-15 dream 跨文件矛盾：local/fallback 跳过

- **位置**：`dream/runner.ts`（P10.3 锁定，故意）  
- 不是 bug；但 `--phases` 输出若只写「无矛盾」会让人以为扫过跨文件。应标明 skipped。

### F-16 成本 cap：`wouldExceedCap` 后 skipped，与缺 key 同形

- 用户可能当成「模型关了」。需在 skipped_reason 区分 `daily_token_cap`（已有字段，CLI 不一定打印）。

### F-17 syncPage 嵌入失败现在抛 `E_INDEX` 且 page 已提交（P12.1）

- **改善**：可续跑。  
- **新缺口**：hook `onFilesWritten` 失败仍 `[E_INDEX] … rebuild-index`（M2）。用户可能跑 **全量** rebuild 而不是 `--pending-embeddings`，把刚写好的索引清掉。warn 文案未更新。

---

## 高（第二遍：job / 索引一致性）

### F-18 多 path 写：hook 半同步

- **位置**：`index/hooks.ts` `onFilesWritten` 顺序 `syncPage`；`write/queue.ts` 一次 catch  
- **现状**：compile 一次返回多 path，前面已进索引、后面抛错 → 半新鲜。  
- **方向**：逐 path try/catch 汇总错误；或全部成功再算 hook 成功。

### F-19 Iron Law 改了实体 md，不进 hook path 列表

- **位置**：`write/iron-law.ts` `appendEntityBacklink` 直接 `writeFile`；`capture.ts` 只把主节点 path 交给 hook  
- **现状**：实体页 links / registry 要等到 `rebuild-index` 才进索引。图臂、entity boost 静默旧。P9.7 允许子步骤不回滚主节点，**不**等于允许索引漏 path。  
- **方向**：`applyIronLaw` 返回改过的实体 path，全部走 `queue.execute` 或显式 `syncEntity`。

### F-20 部分 compile 写入：inbox=`failed`，job=`done`

- **位置**：`compile/session.ts` 非 allWritten → `markFailed`；`jobs/runner.ts` 仍 `status: "done"`  
- **缺陷**：`memory job status` 当成功；自动化只信 job 会把失败当完成。  
- **方向**：`result.errors.length > 0` 或 inbox 非 done → job `failed`；或显式 `partial`。

### F-21 实体创建失败却标 `written`，retry 跳过

- **位置**：`compile/session.ts` entity catch 里 `ent.status = "written"`  
- **缺陷**：`inbox retry` 按 written 跳过，失败实体永不补。  
- **方向**：只在成功时 written；失败保持 pending/failed。

### F-22 `JobRunner.wait` 超时：调用方 failed，盘上仍 `running`

- **位置**：`jobs/runner.ts` wait 超时不写 job 文件（注释：executor 是唯一写者）  
- **缺陷**：`--wait` 看到 `E_TIMEOUT`，随后 `job status` 仍 running。  
- **方向**：超时幂等落盘 `failed/E_TIMEOUT`。

---

## 中（第二遍）

### F-23 capture job 丢掉 enrich 错误

- **位置**：`jobs/runner.ts` `acceptCaptureJob` 常 `errors: []`  
- **现状**：`--wait --extract` 校验/cost_cap 失败仍 job done、退出 0。  
- **方向**：`EnrichResult.error` 进 output.errors；必要时 fail job。

### F-24 损坏的 job JSON → `E_NOT_FOUND` 而非 `E_JOB`

- **位置**：`jobs/runner.ts` `readJob` parse 失败返回 null  
- **对照**：`00-conventions` `E_JOB` = 任务文件损坏。  
- **方向**：缺文件 vs 损坏分码。

### F-25 P9.2 哈希降级只有 `--explain` 才看得见

- **位置**：`hybrid.ts` `embedding_fallback`；CLI query 默认不 stderr  
- **Spec**：P9.2 §5「explain **或 log** 含 fallback」——log/stderr 半边缺。  
- **方向**：进程内首次 fallback `console.warn`（同 pgvector）；doctor 显示 would-fallback。

### F-26 去重用哈希 query 向量打 OpenAI 索引

- **位置**：`write/dedupe.ts` + factory 缺 key 哈希；旧 chunk 仍是 openai 维  
- **缺陷**：余弦无意义 → 假 duplicate / 假 unique，伤 P11.3。  
- **方向**：runtime 与 `embedding-meta` 不一致 → `skipped_reason: embedding_mismatch`，与语义臂 mismatch 同策略。

### F-27 onnx 权重文件在、`embed()` 未实现

- **位置**：`embed/onnx.ts` 有文件则 factory 返回 `OnnxEmbedding`，`embed()` 抛 `E_DISABLED`  
- **缺陷**：P9.2「禁止声称 onnx 成功」；md 已写、该页索引可能缺。  
- **方向**：未实现推理 = 缺权重：读路径哈希 + flag；strict 写路径 `E_DISABLED`。

### F-28 同库混维向量（key 中途消失）

- **位置**：`sync.ts` hash 短路不重嵌；新页用哈希 384，旧页 openai 1536  
- **现状**：mismatch 会关整臂（安全），但此前去重可能已跑过 F-26。  
- **方向**：写路径检测到 fallback 则跳过 embed 或入队全脑重嵌。

### F-29 `layers refresh` / `layers.auto`：openai 缺 key 静默启发式

- **位置**：`layers/refresh.ts` catch → heuristic；remember 则硬 `E_DISABLED`  
- **方向**：`--json` 带 `skipped_reason`；与 P6.1 对齐或明文裁剪。

### F-30 observer / enqueue 链空 catch

- **位置**：`hybrid.ts` `bumpHitCounts`/`recordQueryStat` `.catch(() => {})`；`jobs/runner.ts` enqueue `.catch(() => {})`  
- **低**：磁盘满时 hotness（P11.2）与 query log（P10.4）停更无声。  
- **方向**：一次 debug warn；explain `observer: failed`。

---

## 对称性一览

| 场景 | 缺 key | HTTP 5xx | provider=off |
|---|---|---|---|
| `query` 语义 | 哈希 fail-open | 关臂、退出 0（F-02） | 关臂 |
| `capture` 索引 embed | 哈希写入 | 该文件索引嵌入失败；P12.1 后 page 仍在 | 不 embed |
| `rebuild --embeddings` | `E_DISABLED` | 可能已 clear（F-03） | 不 embed |
| `remember` compile | job `E_DISABLED` | inbox failed `E_LLM` | job `E_DISABLED` |
| `complete()` | `E_DISABLED` | 无重试 `E_LLM`（F-05） | `E_DISABLED` |

---

## 建议修复顺序（不在本期编码）

0. **信封给宿主 agent**（[`P12-error-to-model.md`](P12-error-to-model.md)）：F-02 / F-12 / F-20 / F-25 先变成 `ok` + `degradation`/`error`；**禁止**再调仓内 LLM 判错  
1. F-20 / F-21 / F-22：job ↔ inbox ↔ retry 一致性（会撒谎的状态；信封里必须与 inbox 同码）  
2. F-02 + F-05：读路径重试；重试仍失败则进信封，不空 catch  
3. F-19 Iron Law 漏索引 path  
4. F-01 postgres 无扩展走 BYTEA  
5. F-18 hook 半同步；F-03 rebuild 仍先 clear  
6. F-26 / F-27 / F-28 向量档不要混、不要冒充 onnx  
7. F-04 / F-23：缺 key 预检与 enrich 错误进 job ——与配置 CLI 一起做  
8. F-06–F-08：门闩收敛（见配置方案）
