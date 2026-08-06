# OpenViking 深度调研报告

> 调研对象：`D:\memory_projects\OpenViking`（[volcengine/OpenViking](https://github.com/volcengine/OpenViking)，"The Context Database for AI Agents"）
> 调研日期：2026-08-02 ｜ 语言：中文
> 报告定位：分析 OpenViking 的优点、特点、实现亮点、技术栈与缺点，辅以项目公开的数据支撑（均标注出处）。

---

## 一、项目概述

**定位**：OpenViking 是给 AI Agent 用的"上下文数据库"（context database），把**记忆（Memory）、资源（Resource）、技能（Skill）**三类上下文统一组织成一个虚拟文件系统，通过 `viking://` 协议访问（`README.md:32-34`）。

与 black-box vector store 的对立叙事非常明确："an agent browses its own context with `ls`, `tree`, and `find` instead of querying a black-box vector store"。

- **团队**：volcengine（火山引擎）组织，代码版权头为 "Beijing Volcano Engine Technology Co., Ltd."，pyproject 作者 ByteDance。
- **研究背景**：OpenViking 是 **VikingMem 论文**核心能力的开源子集（*VikingMem: A Memory Base Management System for Stateful LLM-based Applications*，arXiv:2605.29640，**VLDB 2026 收录**）。
- **许可证**：主项目 **AGPLv3**；`crates/ov_cli` 标注 Apache 2.0（`Cargo.toml` 里写 MIT，两处不一致）；`examples/` Apache 2.0。
- **成熟度**：classifier 标注 "Development Status :: 3 - Alpha"，README 自述 "still in its early stages"；但迭代极快，2026-07 已到 v0.4.9（v0.4.8 引入 NVIDIA cuVS GPU 向量后端、Memory v3 管线）。URI scope 语义在 0.3.x→0.4.x 间发生过破坏性变化。
- **商业运营**：官方托管 OpenViking Personal（基于 VikingDB，50 文件免费试用）、火山引擎中国区官方托管、企业版规划。

**技术栈**（Rust + C++ + Python 混编）：

- **Rust 核心**：`crates/ragfs`（AGFS 文件系统，基于 gitoxide 做 in-process Git 版本控制）、`crates/ov_cli`（CLI，clap/TUI）、`ragfs-python`（PyO3 binding）；
- **Python 服务端**：FastAPI + litellm + tree-sitter + MCP + opentelemetry + lark-oapi（飞书）；
- **C++ 向量索引引擎**（`src/`）：内嵌本地向量库（leveldb、croaring、spdlog），打包 `.abi3.so`/`.pyd`；
- **CLI 形态**：`ov` 命令 = Rust 二进制（`openviking_cli/rust_cli.py` 只是极简 Python 包装器）；
- **多语言 SDK**：sdk/python、sdk/typescript、sdk/go。

---

## 二、核心理念与理论

### 2.1 虚拟文件系统心智模型

设计哲学（`docs/en/getting-started/01-introduction.md`）："Moving away from traditional flat database thinking, all context is organized as a virtual file system. Agents no longer rely solely on vector search to find data — they can locate and browse data through deterministic paths and standard file system commands."

三种上下文类型（`docs/en/concepts/02-context-types.md`）：

| 类型 | 用途 | 生命周期 | 主动性 |
|---|---|---|---|
| Resource | 知识与规则 | 长期、相对静态 | 用户添加 |
| Memory | Agent 认知 | 长期、动态更新 | Agent 记录 |
| Skill | 可声明的 Agent 能力 | 长期、静态 | 用户或系统添加 |

每个 context 有唯一 URI：`viking://{scope}/{path}`。

### 2.2 L0/L1/L2 三层信息模型

（`docs/en/concepts/03-context-layers.md`）：

- **L0 Abstract** `.abstract.md`：~100 token，用于向量检索与快速过滤；
- **L1 Overview** `.overview.md`：~1-2k token，用于 rerank 与内容导航（含"去读哪个 L2 文件"的指引）；
- **L2 Detail** 原始文件：无上限，按需读取。

**关键点：每个目录自己也有 .abstract.md / .overview.md**，因此"在读取任何完整文件之前就能判断相关性"。生成顺序 Leaf → Parent → Root（自底向上），子目录 L0 聚合进父目录 L1。

### 2.3 "Context Database Paradigm"

核心论点：现有 RAG 是"扁平黑盒"，检索无全局视角；把上下文当数据库+文件系统管理，可以支持**目录递归检索、分层加载、可观测轨迹、记忆迭代**。对比黑盒向量库的痛点：上下文碎片化、上下文爆炸、检索质量差、上下文不透明、记忆迭代受限。

### 2.4 记忆自迭代闭环

"Sessions become memory"：会话 commit 后异步提取用户偏好与 agent 经验 → 长期记忆 → 下次检索被召回 → "agent becomes smarter with use"。内置 11 类记忆类型（profile/preferences/entities/events/identity/soul/cases/trajectories/experiences/tools/skills）。

---

## 三、架构

### 3.1 分层（`docs/en/concepts/01-architecture.md`）

```
Client (OpenViking) → Service Layer → {Retrieve / Session / Parse} → Compressor → Storage (AGFS + Vector Index)
```

- **Client**：`openviking/client.py`、`sync_client.py`、`async_client.py`；
- **Service 层**：FSService、SearchService、SessionService、ResourceService、RelationService、PackService、DebugService（HTTP Server 与 CLI 复用）；
- **Retrieve**：IntentAnalyzer + HierarchicalRetriever + Rerank；
- **Session**：消息记录、usage 跟踪、压缩、记忆提交；
- **Parse**：文档解析（无 LLM）+ TreeBuilder + 异步语义生成；
- **Compressor**：schema 驱动的记忆提取 + LLM 去重决策；
- **Storage**：VikingFS + AGFS/RAGFS + Vector Index。

### 3.2 数据流

- **写路径**：`Input → Parser → TreeBuilder → AGFS → SemanticQueue → Vector Index`（解析与语义解耦，语义生成异步）；
- **读路径**：`Query → Intent Analysis → Hierarchical Retrieval → Rerank → Results`；
- **会话提交**：`Messages → Compress → Archive → Memory Extraction → Storage`。

### 3.3 部署形态

- **Embedded 模式**：`client = OpenViking(path="./data")`，单进程本地；
- **HTTP 模式**：`openviking-server` 独立进程，任何语言 HTTP API 接入；
- Docker 镜像（server + vikingbot + web studio），helm 部署。

### 3.4 viking:// URI 协议

- scope 体系：`resources`（账号级共享）、`user`（当前用户，含 sessions）、`agent`（账号级共享 Agent 能力）、`temp/queue/upload`（内部，不可寻址）；
- **路径变量**：`{namespace:key}`（如 `{calendar:today}` → 具体日期）；
- 特殊文件：`.abstract.md`（L0）、`.overview.md`（L1）、`.relations.json`、`.meta.json`。

### 3.5 HTTP Server

FastAPI app，路由覆盖 admin/bot/console/content/debug/filesystem/metrics/observer/pack/privacy/relations/resources/search/sessions/skills/snapshot/stats/system/tasks/user_settings/watches/**webdav**（把 resources 暴露为 WebDAV！）。**MCP 端点** `/mcp` 暴露 find/search/read/list/remember/add_resource/grep/glob/forget/health 等工具。多租户认证：`api_key` / `trusted` 模式，ROOT/ADMIN/USER 三级角色。

### 3.6 Agent 集成

Claude Code、Codex、OpenClaw、Hermes、Cursor、Trae、OpenCode、pi、MCP clients、LangChain/LangGraph。集成模式：插件做两件事——(1) 注入 OpenViking 召回（recall）；(2) 自动 commit 会话记忆。OpenClaw 插件最完整。

---

## 四、记忆核心实现

### 4.1 写路径：内容 → L0/L1/L2

- **Parser**（`openviking/parse/`）：格式解析，无 LLM；支持 markdown/text/pdf/html/代码仓库（尊重 .gitignore）/图像/视频/音频。智能切分：`document_tokens <= 1024` 单文件；否则按标题切分，<512 token 小节合并，>1024 token 小节建子目录。
- **SemanticQueue**（异步，自底向上）：对每个目录并发生成文件摘要（限 10 并发）→ 收集子目录 .abstract → 生成 .overview（LLM）→ 抽取 .abstract → 写回 AGFS → 向量化。

### 4.2 存储层

- **双层存储**：内容全在 AGFS（Rust RAGFS），向量索引只存 URI/向量/元数据。单数据源、内存优化、可独立扩展。
- **VikingFS**：URI 抽象层，URI 映射 `viking://resources/docs/auth → /local/{account_id}/resources/docs/auth`；`rm` 自动删索引前缀，`mv` 自动更新 uri/parent_uri。
- **AGFS/RAGFS**：POSIX 风格文件操作，插件式文件系统（localfs/s3fs/memfs/kvfs/sqlfs/queuefs），radix-trie 路由；多写模式（primary + backups）；gitoxide 按 account 粒度做 commit/restore/show 快照回滚。
- **向量索引**：本地 C++ 引擎（flat_hybrid 混合索引、cosine、int8 量化）+ vikingdb + cuVS(GPU) + ollama 等适配器。

### 4.3 session commit → 记忆提取管线（核心亮点）

`openviking/session/session.py` 的 `commit_async()`（1675 行起）分两阶段：

- **Phase 1（同步，立即返回）**：消息切分 archive/retain，写 archive 原始消息，入队 Phase 2，返回 task_id；
- **Phase 2（异步后台，`_run_memory_extraction`，2192 行起）**：生成结构化摘要 → 写 .abstract/.overview → **提取长期记忆** → 写 `memory_diff.json`（审计/回滚）→ 更新 active_count → 写 .done 标记。

两个记忆步：**long_term**（用户偏好/画像/实体/事件）与 **execution**（trajectories 轨迹 / experiences 经验 / session skills）。

**提取流程**：
```
Messages → LLM Extract → Candidate Memories
          → Vector Pre-filter → Find Similar Memories
          → LLM Dedup Decision → candidate(skip/create/none) + item(merge/delete)
          → Write to AGFS → Vectorize
```

- **ExtractLoop**：简化 ReAct 编排器——LLM 带工具（read/write/search）自主决定继续查还是输出最终 operations JSON；最多 3 轮；失败容忍；
- **MemoryUpdater**：系统执行器，把 LLM 输出写到 AGFS：upsert/delete、merge_op（immutable/patch 等）合并、links/backlinks 双向关系、版本号递增、重向量化；
- **schema 驱动**：每种记忆类型是 YAML schema（`openviking/prompts/templates/memory/*.yaml`），定义字段、merge_op、文件名模板、embedding 模板。例如 `preferences.yaml` 的 topic 字段 `merge_op: immutable`、content 字段 `merge_op: patch`；`trajectories.yaml` 的 content 是严格的"操作契约"模板（Trigger/Procedure/Applicability Boundary/Write Field Provenance 等 11 个标签）；
- **memory_diff.json**：每次 commit 记录 adds/updates/deletes，支持审计与回滚；
- **session train**：完整的轨迹分析 → 梯度估计 → policy optimization 框架，支持多轮 self-improvement（tau2 实验用的就是它）。

### 4.4 检索轨迹的可观测性

- `HierarchicalRetriever.retrieve()` 返回 `QueryResult(query, matched_contexts, searched_directories)`——searched_directories 是本次检索实际下钻过的目录列表；
- `FindResult` 含 `query_plan`；`ov observer` 可看检索统计表（total queries / zero-result rate / avg score / latency / rerank 使用情况）；
- telemetry：opentelemetry + trace_id，session commit 每阶段有 trace_id。

> 诚实边界：目录浏览轨迹的粒度主要是"进入过哪些目录"，尚未看到把每一步下钻路径完整序列化给用户 UI 的代码；README 的 "you can see exactly which path produced it" 更接近 searched_directories + query_plan + observer 的组合。

---

## 五、检索算法

### 5.1 两阶段：find vs search

| 特性 | find() | search() |
|---|---|---|
| 会话上下文 | 不需要 | 需要 |
| 意图分析 | 不用 | LLM 分析（0-5 个 TypedQuery） |
| 延迟 | 低 | 高 |
| 用途 | 简单查询 | 复杂任务 |

### 5.2 意图分析（`openviking/retrieve/intent_analyzer.py`）

输入：会话压缩摘要 + 最近 5 条消息 + 当前 query；输出 0-5 个 TypedQuery。查询风格：skill 用动词开头、resource 用名词短语、memory 用 "User's XX"。query_planner 可配轻量微调模型（`ov_intent_analysis_sft`）。

### 5.3 目录递归检索（HierarchicalRetriever，核心算法）

1. 按 context_type 确定根目录；
2. **全局向量检索**定位起始目录（GLOBAL_SEARCH_TOPK=10，只在 level 0/1 上检索）；
3. 起始点合并 + rerank；
4. **递归下钻**：优先级队列（按分数）弹目录 → 搜子节点 → 每个结果最终分 = `alpha * embedding_score + (1-alpha) * parent_score`（`score_propagation_alpha` 默认 1.0）→ 超过阈值收集，非叶子（level 0/1）继续入队递归；
5. 收敛检测：topk 连续 3 轮不变或池不再增长就停（MAX_CONVERGENCE_ROUNDS=3）；
6. 只下钻 level 0/1（L2 文件是终点命中）。

关键常量（hierarchical_retriever.py:53-58）：MAX_CONVERGENCE_ROUNDS=3、MAX_RELATIONS=5、DIRECTORY_DOMINANCE_RATIO=1.2、GLOBAL_SEARCH_TOPK=10、MAX_PARALLEL_CHILD_SEARCHES=4。

- **hotness 混合**（`memory_lifecycle.py`）：`hotness = sigmoid(log1p(active_count)) * exp(-decay*age)`（半衰期默认 7 天），与语义分混合——**冷热记忆生命周期管理**；
- **rerank**：THINKING 模式用 doubao-seed-rerank 对每个层级候选重打分，失败回退向量分；
- **QUICK 模式**：单次向量检索 + 阈值过滤，不递归。

### 5.4 结果带上下文

MatchedContext 返回 uri/context_type/level/abstract/score/relations；结果 URI 按 level 附 `.abstract.md` 或 `.overview.md` 后缀——返回的是"可立即判断相关性"的 L0/L1 文本，而不是把整份 L2 塞进上下文。目录本身也是候选（level 0/1），结果天然带目录上下文。

---

## 六、团队 / 多用户能力

- **多租户模型**（`docs/en/concepts/11-multi-tenant.md`）：`account`（租户外层）+ `user`（租户内用户）双边界。account 之间完全隔离；account 内 `viking://resources` 共享；user 的记忆/session 隔离。角色 ROOT/ADMIN/USER。
- **存储层自动加前缀**：`viking://user/alice/memories → /local/{account_id}/user/alice/memories`——**隔离在存储层强制而非业务层自觉**。
- **Peer 隔离**：`viking://user/{user_id}/peers/{peer_id}/memories/`（对某交互对象的记忆）。
- **多 agent 共享**：`viking://agent/` scope 账号级全局共享（skills/endpoints/tools）；OpenClaw 插件"一个实例一个 user key"模型，VikingBot"平台用 root key 管理大量终端用户"模型。

---

## 七、数据支撑（Benchmark）

### 7.1 LoCoMo（长期对话用户记忆，`README.md:99-103`）

| 集成 | 原生准确率 | +OpenViking | 平均查询时间 | 输入 token |
|---|---|---|---|---|
| OpenClaw native memory | 24.20% | **82.08%** | 95.14s → 38.8s | 392.6M → 37.4M |
| Hermes native memory | 33.38% | **82.86%** | 82.4s → 27.9s | 79.2M → 52.0M |
| Claude Code auto-memory | 57.21% | **80.32%** | 49.1s → 20.4s | 353.3M → 130.0M |

- 效率：延迟下降 **58.45%–66.10%**；token 下降 **34.3%–91.0%**（OpenClaw -91.0% / Hermes -34.3% / Claude Code -63.2%）。

### 7.2 tau2-bench（Agent 经验记忆，`README.md:99`）

| 设定 | Retail | Airline |
|---|---|---|
| LLM 无记忆 | 70.94% | 54.38% |
| LLM + OpenViking 经验记忆 | **77.81% (+6.87pp)** | **66.25% (+11.87pp)** |

复现协议（`benchmark/tau2/vikingbot/README.md`）：只用 train split 提取记忆、test split 隔离评估（无泄漏）；每 epoch train 1 次 + test 8 次取平均。

### 7.3 附加数据（官方博客 benchmark 报告）

- **ClawWork**：净收入 50 任务 $2,269.77 → $3,843.74（+69.34%）；每小时 token 1,030.3K → 872.4K（-22.8%）；
- **HotpotQA**：OpenViking top-20 检索准确率 91.00%、检索延迟 0.23s（对比 Naive RAG 62.50%/0.11s、LightRAG 89%/75s、HippoRAG 2 61%/20s）；
- **单轮 RAG 平均**（FinanceBench/NQ/ClapNQ/Qasper/SyllabusQA）：OpenViking 66.87% 平均准确率、0.19s 检索延迟、索引 token 8.67M（约为 LightRAG 的 13.8%）。

### 7.4 口径注意点（诚实评估）

- 三个 agent 的"原生记忆"基线差异大（24%/33%/57%），OpenViking 统一拉平到 80-83%；
- token/延迟数字来自官方博客，**无第三方独立复现**；
- tau2 对比对象是"无记忆的 LLM"，非与其他记忆系统横向对比；
- LoCoMo 用 LLM 裁判（judge.py）打分（默认 doubao-seed-2-0-pro）。

---

## 八、优点

1. **文件系统心智模型 + 确定性定位**：记忆/资源/技能统一成 `viking://` 文件树，agent 用 ls/tree/find/grep 操作上下文，比黑盒向量库可解释、可控制、可调试。对需要人工组织/审查的场景（团队项目记忆）尤其有价值。
2. **L0/L1/L2 分层加载省 token**：写入时一次性花成本做抽象/概览，读取时按需下钻；目录也带 L0/L1，相关性判断不用打开文件。benchmark 显示 token 最多降 91%。
3. **目录递归检索保留上下文**：先定位高分目录再逐层下钻，结果是"带着目录上下文的块"而不是孤立碎片。
4. **可观测检索轨迹**：searched_directories + query_plan + observer 统计，出错可定位到具体路径。
5. **schema 驱动的记忆类型系统**：记忆类型是 YAML 定义（字段、merge_op、embedding/文件名模板），可扩展；merge_op immutable/patch 让记忆更新语义化，配合 LLM 去重决策与 memory_diff 审计/回滚。
6. **写读路径解耦 + 异步语义**：解析（无 LLM）与语义生成（异步队列）分离，commit 立即返回、后台提取。
7. **技术纵深完整**：Rust + C++ + Python 混编、MCP 原生端点、WebDAV、gitoxide 版本快照、多写存储、GPU 检索、多语言 SDK、开放遥测。
8. **多租户即第一公民**：account/user/peer 三级身份在存储层自动加前缀，一套服务服务多团队。

---

## 九、缺点 / 局限

1. **成熟度仍为 Alpha/0.x**：URI scope 语义有破坏性变更；文档与代码不一致（`crates/ov_cli/Cargo.toml` 写 MIT，README/crates/LICENSE 写 Apache 2.0）。
2. **AGPLv3 对商用是硬约束**：主项目 AGPL 意味着网络服务需开源修改后的完整代码；官方因此另做托管服务与企业版——开源版本质上是引流/共建渠道。
3. **基准口径需谨慎**：无第三方复现；基线选择直接影响提升幅度表述；tau2 只对比"无记忆 LLM"。
4. **LLM 依赖较重**：意图分析、L0/L1 生成、记忆提取/去重、rerank 全依赖 LLM，私有化/离线部署门槛较高。
5. **实现深度参差**：检索"轨迹"可观测目前主要是 searched_directories + 统计表，未把每次下钻路径完整结构化为用户可视化轨迹（README 叙述略超前于代码）；agent/endpoints|tools|payments 多数 "planned"。
6. **记忆提取的"幻觉"风险**：LLM 从会话提取偏好/经验直接写入用户记忆空间，若提取错误影响后续所有检索；虽有去重/审计/diff，但无默认人工确认工作流。
7. **Web Studio 以构建产物随 pip 分发**：`web_studio/dist` 作为 package-data，独立二次开发不便。
8. **对火山生态的倾向**：默认推荐 Doubao 模型与 VikingDB，部分功能强绑定。

---

## 十、可借鉴点（站在"团队项目记忆系统"角度）

1. **以"可寻址的文档树"组织记忆，而非扁平向量库**：团队记忆天然按项目/主题/成员/时间组织，`viking://` 式确定性路径 + 标准文件操作心智负担低、可审计、可人工整理。
2. **写入时分层（L0/L1/L2）而非读取时压缩**：把"摘要/概览/全文"作为一等公民在写入管线异步生成，检索时按需取层，是省 token 的关键工程手段。
3. **目录级检索 + 下钻保留上下文**：先定位目录再深入，召回结果带语境——团队 Wiki/代码库检索特别需要。
4. **schema 化记忆类型 + merge_op 语义更新**：把"记忆是什么、字段怎么合并"声明成 schema，LLM 提取输出受控，更新有明确语义（immutable/patch/merge）。
5. **记忆变更审计（memory_diff）**：每次 commit 记录 adds/updates/deletes，可回滚可追溯——团队共享记忆几乎必须。
6. **异步、可重试、可观测的记忆提取管线**：commit 立即返回、后台带重试（指数退避），任何一步失败不阻塞主链路 + trace_id 贯穿。
7. **身份边界前置到存储层**：account/user/peer 在 URI 解析时就带前缀，隔离由架构保证而非业务自觉。
8. **以 MCP/插件形式无缝接入现有 agent 生态**：内置 MCP 端点 + 各 agent 插件，把记忆能力暴露成标准工具（find/remember/read）。
9. **谨慎借鉴**：LLM 自动提取的信任边界（加人工确认或低置信降级）；AGPL 授权策略要想清楚商用约束；对单一云厂商的绑定要评估可替换性（其 provider 抽象做得不错，值得学）。

---

## 附：关键文件索引

- `README.md`、`README_CN.md`、`CONTRIBUTING.md`
- `docs/en/concepts/01-architecture.md`、`02-context-types.md`、`03-context-layers.md`、`04-viking-uri.md`、`05-storage.md`、`06-extraction.md`、`07-retrieval.md`、`08-session.md`、`11-multi-tenant.md`
- `openviking/session/session.py`（commit_async 1675 行、_run_memory_extraction 2192 行）
- `openviking/session/memory/{extract_loop,memory_updater,memory_policy}.py`
- `openviking/retrieve/hierarchical_retriever.py`、`intent_analyzer.py`、`memory_lifecycle.py`、`retrieval_stats.py`
- `openviking/storage/viking_fs.py`、`crates/ragfs/`、`src/`（C++ 向量引擎）
- `openviking/prompts/templates/memory/*.yaml`（记忆 schema）
- `crates/ov_cli/src/commands/`（CLI）、`openviking/server/`（HTTP/MCP）
- `benchmark/locomo/`、`benchmark/tau2/`、`benchmark/RAG/`
- 论文：VikingMem，arXiv:2605.29640（VLDB 2026）
