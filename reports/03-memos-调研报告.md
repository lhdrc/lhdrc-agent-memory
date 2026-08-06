# MemOS 深度调研报告

> 调研对象：`D:\memory_projects\MemOS`（[MemTensor/MemOS](https://github.com/MemTensor/MemOS)，MemOS 2.0 Stardust，"Memory Operating System"）
> 调研日期：2026-08-02 ｜ 语言：中文
> 报告定位：分析 MemOS 的优点、特点、实现亮点、技术栈与缺点，辅以项目公开的数据支撑（均标注出处）。

---

## 一、项目概述

**定位**：MemOS 是面向 LLM 与 AI Agent 的"记忆操作系统"（Memory Operating System），统一长期记忆的**存/取/管**，口号 "Give your Agent persistent memory and the ability to grow" / "让 Agent 拥有持续记忆与成长能力"（`README.md:19`、`README_ZH.md:19`）。

- **仓库**：`github.com/MemTensor/MemOS`（MemTensor 团队），文档 `memos-docs.openmem.net`。
- **版本**：`MemoryOS==2.0.27`（`pyproject.toml`），requires-python >= 3.10。
- **许可证**：Apache 2.0。
- **论文**：arXiv:2507.03724（*MemOS: A Memory OS for AI System*）与 2505.22101（早期短文）。
- **四种入口**（`README.md:96-101`）：Cloud API（托管）/ Self-Host（docker compose，Neo4j + Qdrant）/ OpenClaw Cloud Plugin / Local Plugin（100% 端侧）。
- **三个 sub-project**：
  - `apps/memos-local-plugin/`：TypeScript 本地插件（SQLite + FTS5 + 向量），面向 OpenClaw/Hermes，核心是 **Reflect2Evolve** 算法（L1 轨迹 / L2 策略 / L3 世界模型 / Skill 结晶）；
  - `apps/MemOS-Cloud-OpenClaw-Plugin/`：云端插件；
  - `apps/openwork-memos-integration/`。
- **评测框架**：OmniMemEval（`github.com/MemTensor/OmniMemEval`），对 14 款商业记忆产品横向对比。

**技术栈**：Python（主库）/ TypeScript（本地插件），FastAPI 服务 + MCP 服务（`src/memos/api/mcp_serve.py`）。Provider 三件套模式（base.py 抽象类 + factory.py 注册表 + configs/<类别>.py），Pydantic v2 配置，Ruff 格式化。

---

## 二、核心理念与理论

- **记忆是一等公民（first-class resource）**：把记忆当作与算力/存储并列的操作系统资源统一管理（结构、生命周期、调度）（`docs/en/open_source/home/overview.md`）。
- **三种记忆分类法**（`docs/en/open_source/home/core_concepts.md`）：
  1. **Parametric Memory（参数记忆）**：沉淀在模型权重里的知识（如 LoRA），"常青技能"——**当前代码中标注 Coming Soon / 占位实现**；
  2. **Activation Memory（激活记忆）**：短期 KV-Cache，用于推理加速；
  3. **Plaintext Memory（文本记忆）**：文本/图节点/向量块，可搜索、可检查、可编辑——**不是黑盒向量库**。
- **记忆 = 可组装资源**：多记忆类型以"插件 cartridge"形式装进 MemCube，不同用户/会话/任务可各自组装不同记忆栈。
- **记忆需要"操作系统"级调度**：写入异步化（MemScheduler）、自然语言反馈修正（MemFeedback）、图结构演化（organize/reorganize）、多用户隔离与共享。
- **记忆应该能自己"成长"**：从 step 级轨迹归纳可复用策略（L2）、压缩环境认知（L3）、结晶成可调用 Skill——"记忆作为可演化资产"。

---

## 三、架构

### 3.1 顶层分层（`src/memos/`）

```
mem_os (MOS / MOSCore)          ← 编排层：多用户、多 MemCube 管理
 ├─ mem_cube (GeneralMemCube)    ← 记忆容器：text_mem / act_mem / para_mem / pref_mem
 ├─ memories/                    ← 记忆类型实现（textual/activation/parametric + factory）
 │    └─ textual/tree_text_memory/  ← 图结构记忆
 ├─ mem_scheduler/               ← 异步调度器（队列/分发/监控/后处理）
 ├─ mem_feedback/                ← 自然语言反馈修正
 ├─ mem_user/                    ← 多用户/多租户（SQLite/MySQL/Redis 后端）
 ├─ multi_mem_cube/              ← View 架构（SingleCubeView / CompositeCubeView）
 ├─ llms/  embedders/  vec_dbs/  graph_dbs/  chunkers/  parsers/  reranker/
 └─ api/                         ← FastAPI + MCP 服务
```

### 3.2 MOS / MOSCore（`src/memos/mem_os/`）

- `MOS`（main.py:24）继承 `MOSCore`，`MOS.simple()` 从环境变量自动配置并注册默认 cube；带 PRO_MODE 的 CoT 复杂查询分解增强（`_chat_with_cot_enhancement`）。
- `MOSCore`（core.py:38）：管理多 MemCube（`OptimizedThreadSafeDict` 线程安全），核心方法 `register_mem_cube` / `add` / `search` / `chat` / `get/get_all/update/delete` / `create_user` / `create_cube_for_user`。
- `add()` 用 `ContextThreadPoolExecutor(max_workers=2)` 并行跑 text_mem 与 pref_mem；`search()` 同样并行。
- **权限边界**：`_validate_user_exists` + `_validate_cube_access`，所有跨用户操作前校验（core.py:200-231）。

### 3.3 MemCube（`src/memos/mem_cube/`）

`GeneralMemCube`（general.py:21）聚合四种记忆槽位 `_text_mem/_act_mem/_para_mem/_pref_mem`。MemOS 2.0 起运行时操作走 **View 架构**（`src/memos/multi_mem_cube/`）：`SingleCubeView`（cube + mem_reader + scheduler + searcher + feedback + deepsearch_agent）与 `CompositeCubeView`（fan-out 全写，**智能路由未实现，注释明说 TODO**）。

### 3.4 MemScheduler（异步调度器）

三层架构：
- **调度层**：`SchedulerOrchestrator` + `SchedulerDispatcher` + `ScheduleTaskQueue`（Redis Stream 或本地队列）；
- **执行层**：task handler（add/answer/query/mem_read/mem_reorganize/mem_dream/pref_add/feedback/memory_update）；内存管理分工作/长期/激活三层；
- **监控层**：`TaskScheduleMonitor` + prometheus metrics + `TaskStatusTracker`（Redis）+ `WebLog`（audit 日志）。

支持 RabbitMQ / Redis 消息中间件。承诺"毫秒级延迟 / 高并发生产稳定性"（README）。

### 3.5 API 层

FastAPI app，路由分 `server_router.py`（prefix `/product`）与 `admin_router.py`。类化 handler + 依赖注入。端点覆盖 add/search/chat(流式/SSE)/cube 管理/scheduler 状态/feedback/dashboard。语义：`readable_cube_ids` / `writable_cube_ids` 列表表达读写分离。另有 `mcp_serve.py`（FastMCP）。

---

## 四、记忆核心实现

### 4.1 文本记忆类型（`MemoryFactory.backend_to_class`）

| backend | 类 | 存储 | 特点 |
|---|---|---|---|
| `naive_text` | NaiveTextMemory | 内存 list | 零依赖 demo；检索 = token 交集计数 |
| `general_text` | GeneralTextMemory | Qdrant | LLM 抽记忆（JSON）+ embed；tenacity 对 JSONDecodeError 重试 3 次 |
| `tree_text` | TreeTextMemory | Neo4j 图库 | 图节点 + 层级 + 语义图；混合检索；后台 reorganize 演化 |
| `pref_text` | PreferenceTextMemory | Milvus/Qdrant | 显式/隐式偏好双集合；三组件 extractor/adder/retriever |

### 4.2 偏好记忆（`prefer_text_memory/`）

- **Extractor**：`detect_lang` 选择中/英文提示词；对每段 chunk 并行抽取 explicit/implicit preference；
- **Adder（核心是去重/更新决策）**：`_judge_update_or_add_fast`（是否同一核心内容）+ `_judge_update_or_add_fine`（need_update/new_preference/target id）+ `_judge_dup_with_text_mem`（与文本记忆查重）——**写入即 LLM 判定去重/更新**，支持 `PREFERENCE_ADDER_MODE` fast/fine；
- **Retriever**：显式/隐式集合并行向量搜索（各 top_k*2）→ 排序 → reranker → 阈值过滤。

### 4.3 树/图记忆（`tree_text_memory/`）

- **写入侧（organize/）**：`MemoryManager` 管理记忆容量（WorkingMemory 20 / LongTermMemory 1500 / UserMemory 480）；`GraphStructureReorganizer` + QueueMessage（add/remove/merge/update/end）后台重组图结构；
- **检索侧（retrieve/）**：`GraphMemoryRetriever`（recall.py）——**图 + 向量 + BM25 + 全文 混合检索**，按 ID 去重合并；`MemoryReasoner`（reasoner.py）推理校验；`Reranker`（默认 `cosine_local` 按 topic/concept/fact 层级加权）；`TaskGoalParser` 拆解 query 出 keys/tags；
- **TreeTextMemory.search 流水线**（tree.py:157）：`Query -> TaskGoalParser -> MemoryPathResolver -> GraphMemoryRetriever -> MemoryReranker -> MemoryReasoner -> Output`；mode = `fast`（不调 LLM）或 `fine`（调大模型）。

### 4.4 激活 / 参数记忆

- `KVCacheMemory`：torch + `transformers.DynamicCache`；`vllm_kv_cache` 走 vLLM；
- `LoRAMemory`：**明确标注 placeholder/TODO，dump 写 `b"Placeholder"`，不可作为功能模块使用**（与文档 "Coming Soon" 一致）。

### 4.5 记忆读取（`mem_reader/`）

Fast Mode（不调 LLM，chunk+embed，毫秒级）/ Fine Mode（LLM 深度提取）；`read_multi_modal` 支持文本、图像、工具轨迹（多模态记忆）。

---

## 五、检索算法

- **GeneralText**：单向量余弦（Qdrant），无重排。
- **TreeText（图）**：三/四路并行——图结构召回（key/tags 精确过滤）+ 向量召回（双路径、按最高分去重、注入 `relativity` 分数）+ BM25 词法 +（可选）fulltext；按 ID 合并；reranker 在记忆类型层级（topic/concept/fact）加权；`MemoryReasoner` 对召回结果做推理校验。
- **Preference**：双集合并行向量搜索 + reranker（可拼接 original_text）+ 阈值过滤。
- **本地插件（Reflect2Evolve）**——另有一套三阶检索体系：
  - Tier1 任务级（有名技能？）→ Tier2 step 级（上次怎么成功的？）→ Tier3 推理级（处于什么环境？）；
  - 三通道并行（vec 余弦 / FTS5 trigram MATCH / LIKE %term% 兜底中文），**RRF 融合**；
  - 过滤规则（active+candidate 状态、η≥minSkillEta、cosine≥minTraceSim）在 ranking 前机械执行；"是否注入"决策在 ranker（相对阈值 + smart MMR seed）与 llm-filter（precision pass）；
  - **纯读管线，无写无 LLM 调用（除可选 llm-filter）**，RetrievalEventBus 事件 → viewer/audit。

---

## 六、团队 / 多用户能力

- `mem_user/`：`UserManager`（SQLite）、`MySQLUserManager`、`RedisPersistentUserManager` 多后端。
- **`UserRole = ROOT / ADMIN / USER / GUEST`**；`User` / `UserCube` 模型 + `user_cube_association` 多对多表（用户 ↔ cube 访问关系）。
- 权限语义：`validate_user_cube_access`；API 层 `readable_cube_ids` / `writable_cube_ids` 读写分离。
- **多 Cube 知识库管理**：多知识库作为可组合 cube，隔离、受控共享、动态组合（README Key Feature）。
- 本地插件侧 `core/hub/`：multi-agent collaboration hub（多 Agent 协作共享记忆）。

---

## 七、数据支撑（Benchmark）

来源：`README.md:66-77`（OmniMemEval 框架，5 个用户记忆 + 5 个 Agent 记忆任务，与商业记忆产品对比）：

| Benchmark | Score |
|---|---|
| LoCoMo | 88.83 |
| LongMemEval | 89.20 |
| PersonaMem v2 | 40.58 |
| HaluMem | 80.91 |
| BEAM-10M | 56.75 |
| GDPVal | 62.07 |
| LiveCodeBench | 64.96 |
| OmniMath | 61.00 |
| SWE-Bench | 38.46 |
| BrowseComp-Plus | 23.85 |

- **Agent 增益**（News 2026-07-02，`README.md:50`）：OpenClaw 5 个 agent 任务平均完成率 **36.63% → 50.87%**。
- **Token 节省**（News 2026-03-08，`README.md:59`）：OpenClaw Cloud Plugin 声称 **72% 更低 token 用量**。
- **口径注意**（`docs/en/open_source/evaluation/overview.md:71`）：MemOS Cloud 搜索时不支持传 question_date/reference_time，云端分数可能与规范跑法有差异；**要可比数字应优先跑开源版 MemOS server**。
- 评测脚本在 `evaluation/scripts/`（locomo/lme/pm/prefeval 等），并提供 mem0/zep/supermemory/memu 的对照脚本。

---

## 八、优点

1. **体系完整、抽象清晰**："记忆操作系统"不是口号——三层调度、三类记忆、图/向量混合、反馈修正、多用户权限、多库抽象，分层命名规范（base + factory + config 三件套）。
2. **可检视可编辑**：记忆以图组织，支持 dump/load/export_graph/subgraph，不是黑盒；API 语义（readable/writable cube）贴近真实生产需求。
3. **混合检索工程化扎实**：图（key/tags 结构化）+ 向量 + BM25 + fulltext 多路召回 + reranker + reasoner；偏好记忆有专门去重/更新判定。
4. **异步调度**：MemScheduler 提供队列/分发/监控/状态跟踪（Redis）/WebLog/RabbitMQ 可选，为高并发生产场景设计。
5. **工程规范度极高**：AGENTS.md 定义详尽的 provider 扩展流程、TDD、pre-commit/pre-push、extras 依赖分组、Ruff/Pydantic v2/类型注解强制。
6. **评测驱动**：自带 OmniMemEval 评测框架与多 benchmark 脚本 + 竞品对照。
7. **本地插件（Reflect2Evolve）算法设计成熟**：L1 轨迹 → L2 策略归纳（support/gain/status 状态机）→ L3 世界模型 → Skill 结晶，带 reward 反传、skill 验证/打包、检索纯读管线、事件总线可观测——"记忆演化"方向的深度参考。
8. **多 Agent / 多租户**：云端 + 本地 hub 双形态支持协作。

---

## 九、缺点 / 局限

1. **Parametric Memory 未实现**：LoRAMemory 是占位（dump `b"Placeholder"`），宣传的三大记忆类型实际只有两种可用。
2. **CompositeCubeView 智能路由未实现**：当前只是 fan-out 全写，多 cube 动态组合/路由停留在 TODO。
3. **部分接口为兼容旧版保留**：core.py 里 add/get/delete 大量重复"找默认 cube"分支 + `# TODO not only first` 注释，默认 cube 选择逻辑粗糙。
4. **评测数字口径需谨慎**：LongMemEval 云端不支持 reference_time（文档自明差异）；README 高分是否全部为开源 server 口径未在仓库内独立复现。
5. **依赖较重**：默认/文档主力是 Neo4j + Qdrant（docker compose），本地起全套服务成本高；tree_text 检索链路（LLM 解析任务目标、重排、推理）延迟与成本偏高。
6. **图记忆工程复杂度**：reorganize 后台进程、working_binding 清理、版本/evolve_to 机制逻辑复杂，出错面大（多处 logger.warning 兜底与 try/except 吞错）。
7. **文本记忆更新能力不对称**：GeneralTextMemory 支持 update/delete，但 **TreeTextMemory 的 `update()` 直接 `raise NotImplementedError`**，图记忆编辑靠 soft_delete + evolve。
8. **本地插件与主库算法体系不同构**：两套术语/机制并存（text/tree/pref vs L1/L2/L3/Skill），跨生态迁移心智成本高；插件强依赖 LLM 判断。
9. **README 宣称的"毫秒级延迟"无源码内基准**：属运营宣传口径。
10. **代码量大、风格混杂**：class-based vs function-based 并存，部分模块带明显测试/内部用途。

---

## 十、可借鉴点（站在"团队项目记忆系统"角度）

1. **provider 三件套（base/factory/config）+ 可扩展 extras**：新记忆类型 = 一个类 + 一个 config + factory 注册 + tests，扩展路径清晰——适合做插件化记忆框架的骨架。
2. **"记忆类型按场景选"的决策树**：零依赖 demo → naive；语义搜索 → general；画像 → preference；图谱 → tree；加速 → KV cache。产品化记忆库该学这种"给用户明确选择"。
3. **偏好记忆写入即去重/更新的 LLM 判定**：把"新信息 vs 旧信息"是否同义、是否更新、是否与文本记忆重复全部交给 LLM 判定并保留版本/trace——比"无脑追加"或"简单覆盖"更接近真实记忆行为。
4. **多路混合召回 + 分层重排**：图结构化（key/tags）+ 向量 + 词法（BM25/fulltext）并行、按 ID 合并、层级加权 rerank、再加 reasoner 校验。
5. **异步写入 + 状态跟踪 + 可观测**：写入异步化（队列/调度/监控/metrics/SSE 进度）、redis 状态 tracker、web log——高并发生产级记忆系统的必要件。
6. **Reflect2Evolve 的记忆演化闭环**：以 trace 为最小单元（s,a,o,ρ,r）、reward 反传、高价值模式 → L2 策略归纳（candidate→active→archived 状态机）→ 结晶成可校验可打包的 Skill（含反例、命名空间防冲突、LLM 输出归一化+重试）——做"记忆自学习"系统的完整参考实现。
7. **检索侧"纯读 + 事件总线 + 前端可验证"**：本地插件把 retrieval 做成无副作用管线，事件全可观测，viewer 能"确定性看到 X→Y"。
8. **LLM 输出防御式解析**：JSON 剥 code fence、补尾部括号、tenacity 重试 JSONDecodeError、失败回退字符串比较。
9. **评测与榜单驱动发展**：围绕公开 benchmark 建自评框架 + 竞品对照脚本，用数据说服用户。
10. **多租户与权限建模**：user ↔ cube 多对多 + role（ROOT/ADMIN/USER/GUEST）+ readable/writable 分离，是 Agent 记忆服务化的权限骨架。

---

## 附：关键文件索引

- `README.md`、`README_ZH.md`、`AGENTS.md`
- `src/memos/mem_os/{main,core}.py`（MOS/MOSCore）
- `src/memos/mem_cube/general.py`（GeneralMemCube）；`src/memos/multi_mem_cube/`（View 架构）
- `src/memos/memories/textual/{general,preference,tree,naive}.py`、`prefer_text_memory/{extractor,adder,retrievers}.py`
- `src/memos/memories/textual/tree_text_memory/organize/`、`retrieve/{recall,reranker,reasoner,bm25_util}.py`
- `src/memos/mem_scheduler/`（三层调度）、`src/memos/mem_feedback/`、`src/memos/mem_user/`
- `src/memos/api/{server_api,mcp_serve}.py`、`routers/`
- `apps/memos-local-plugin/core/{memory/{l1,l2,l3},skill,reward,retrieval,pipeline,hub}/`
- `evaluation/scripts/`、`docs/en/open_source/evaluation/`
