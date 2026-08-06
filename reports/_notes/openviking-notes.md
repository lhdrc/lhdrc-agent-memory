# OpenViking 深度调研笔记

> 调研对象：`D:\memory_projects\OpenViking`（volcengine/OpenViking，"context database for AI agents"）
> 调研性质：纯研究任务，不修改任何代码。以下内容均基于对仓库源码与文档的实读，引用具体文件路径。
> 调研日期：2026-08-02

---

## 1. 项目概述

### 1.1 定位

- **一句话定位**：`README.md` 开篇即称 "OpenViking: The Context Database for AI Agents"。它是给 AI Agent 用的"上下文数据库"，把 **记忆（Memory）、资源（Resource）、技能（Skill）** 三类上下文统一组织成一个虚拟文件系统，通过 `viking://` 协议访问。
- 与 black-box vector store 的对立叙事非常明确（README 第 34 行）："an agent browses its own context with `ls`, `tree`, and `find` instead of querying a black-box vector store"。
- 核心卖点（README "Why OpenViking"）：
  1. 所有上下文一个文件系统，确定性定位（Viking URI）
  2. L0/L1/L2 分层加载，按需取用，省 token
  3. 目录递归检索（Directory recursive retrieval），结果带上下文
  4. 可观测检索：每次查询保留目录浏览轨迹
  5. 会话提交后异步把用户偏好与 agent 经验提取为长期记忆

### 1.2 作者 / 团队 / 背景

- 仓库归属 **volcengine**（火山引擎）组织：`https://github.com/volcengine/OpenViking`。
- `pyproject.toml` 中 authors 写的是 `ByteDance`（字节跳动）。代码版权头均为 "Beijing Volcano Engine Technology Co., Ltd."。
- 官方站点 openviking.ai，提供托管服务（OpenViking Personal，基于 VikingDB，50 文件免费试用）。
- 火山引擎（中国区）官方托管服务已有产品页（README 引用 volcengine.com/product/openviking-service）。
- 研究背景：README "Research" 部分说明 OpenViking 是 **VikingMem 论文核心能力的开源子集**：
  > VikingMem: A Memory Base Management System for Stateful LLM-based Applications
  > Jiajie Fu, Junwen Chen, Mengzhao Wang, Aoxiang He, Maojia Sheng, Xiangyu Ke, Yifan Zhu, and Yunjun Gao.
  > arXiv:2605.29640, 2026. Accepted by VLDB 2026.
- 文档、博客、社区（Lark/WeChat/Discord）齐全，商业运营痕迹明显（有 Personal 托管、企业版规划）。

### 1.3 许可证

- 主项目 **AGPLv3**（`LICENSE` 为 GNU AGPL v3；README "License" 部分明确）。
- `crates/ov_cli`：README 标注 Apache 2.0（见 `crates/LICENSE`，实际为 Apache License 2.0；不过 `crates/ov_cli/Cargo.toml` 里写的 license = "MIT"，两处不一致，值得注意）。
- `examples/`：Apache 2.0（`examples/LICENSE`）。
- `third_party/`（croaring / krl / leveldb-1.23 / rapidjson / spdlog）：各自原许可。
- `pyproject.toml` license = "AGPL-3.0"。

### 1.4 技术栈

- **Rust 核心**：`Cargo.toml` workspace 含 `ov_cli`（CLI）、`ragfs`（Rust 版 AGFS 文件系统，Apache-2.0）、`ragfs-cache-redis`（缓存）、`ragfs-python`（PyO3 binding）；另有排除在 workspace 外的 mooncake / yuanrong 缓存与 python-native。
  - `ragfs` 依赖：tokio、async-trait、gitoxide（gix-* 做 in-process Git 版本控制）、rusqlite/sqlx、aws-sdk-s3（可选）、radix_trie、filelocks 等。
  - `ov_cli` 依赖：clap、reqwest、tokio、ratatui/crossterm（TUI）、rustyline、termimad、indicatif、image/viuer 等。
- **Python 服务端**：`pyproject.toml` 依赖非常全：fastapi、uvicorn、litellm（模型网关）、pydantic、openai、volcengine SDK、pdfplumber/scrapy/trafilatura（文档抓取）、tree-sitter（多语言代码解析）、mcp（MCP 端点）、apscheduler、opentelemetry、argon2-cffi/cryptography（加密）、lark-oapi（飞书）。
- **CLI 形态**：`ov` 命令 = Rust 二进制（`openviking_cli/rust_cli.py` 只是个"极简 Python 包装器"，找到 `ov` 二进制后 execv/subprocess；设计上支持 npm / cargo / 官方脚本独立安装）。`openviking` 是 `ov` 的别名。
- **C++ 向量索引引擎**：`src/` 下是 C++（`src/index/`、`src/store/`、`src/common/`，CMake 构建），打包为 `.abi3.so`/`.pyd`（见 `pyproject.toml` package-data 中 `storage/vectordb/engine/*.abi3.so`）。即本地向量库是内嵌的 C++ 实现（leveldb、croaring、spdlog 等 third_party 佐证）。
- **前端/门户**：`web-studio/`（Web Studio 在 `/studio`，构建产物随 pip 包分发）、`openviking_assets`、npm 包。
- **多语言 SDK**：`sdk/python`（openviking-sdk）、`sdk/typescript`、`sdk/go`。

### 1.5 版本与成熟度

- `pyproject.toml` classifier 标注 "Development Status :: 3 - Alpha"。README 自述 "still in its early stages"。
- 但实际迭代极快：changelog（`docs/en/about/02-changelog.md`）显示 2026-07 已到 v0.4.9，v0.4.8 引入 NVIDIA cuVS GPU 向量后端、Memory v3 管线、递归网页抓取等。版本号 0.x，语义上仍在快速演进期（有 breaking change，如 viking://user 命名空间 0.3.x→0.4.x 的兼容迁移）。

---

## 2. 核心理念 / 理论

### 2.1 虚拟文件系统心智模型

- 设计哲学（`docs/en/getting-started/01-introduction.md`）："Moving away from traditional flat database thinking, all context is organized as a virtual file system. Agents no longer rely solely on vector search to find data — they can locate and browse data through deterministic paths and standard file system commands."
- 三种上下文类型（`docs/en/concepts/02-context-types.md`）：
  | 类型 | 用途 | 生命周期 | 主动性 |
  |---|---|---|---|
  | Resource | 知识与规则 | 长期、相对静态 | 用户添加 |
  | Memory | Agent 认知 | 长期、动态更新 | Agent 记录 |
  | Skill | 可声明的 Agent 能力（AgentDefinedContextType） | 长期、静态 | 用户或系统添加 |
- 每个 context 有唯一 URI：`viking://{scope}/{path}`（`docs/en/concepts/04-viking-uri.md`）。

### 2.2 L0/L1/L2 三层信息模型

- `docs/en/concepts/03-context-layers.md`：
  - **L0 Abstract** `.abstract.md`：~100 token，用于向量检索与快速过滤
  - **L1 Overview** `.overview.md`：~1-2k token，用于 rerank 与内容导航（含"去读哪个 L2 文件"的指引）
  - **L2 Detail** 原始文件：无上限，按需读取
- 关键点：**每个目录自己也有 .abstract.md / .overview.md**，因此"在读取任何完整文件之前就能判断相关性"。
- 生成顺序：Leaf → Parent → Root（自底向上），子目录的 L0 聚合进父目录的 L1。
- 多模态：L0/L1 恒为文本 markdown；L2 可任意格式，二进制内容用文本描述（`03-context-layers.md` 的图片示例）。

### 2.3 "Context Database Paradigm" 设计哲学

- README 引用博客《The Database Paradigm for Context Engineering》（blog.openviking.ai）。
- 核心论点是：现有 RAG 是"扁平黑盒"，检索无全局视角；而把上下文当数据库+文件系统管理，可以支持**目录递归检索、分层加载、可观测轨迹、记忆迭代**。
- 对比 black-box vector store 的差异（`01-introduction.md` 列出的痛点）：上下文碎片化、上下文爆炸、检索质量差、上下文不透明、记忆迭代受限。

### 2.4 记忆自迭代闭环

- "Sessions become memory"：会话 commit 后异步提取用户偏好与 agent 经验 → 长期记忆 → 下次检索被召回 → "agent becomes smarter with use"（自我进化）。内置 11 类记忆类型（profile / preferences / entities / events / identity / soul / cases / trajectories / experiences / tools / skills）。

---

## 3. 架构

### 3.1 分层（`docs/en/concepts/01-architecture.md`）

```
Client (OpenViking) → Service Layer → {Retrieve / Session / Parse} → Compressor → Storage (AGFS + Vector Index)
```

- **Client**：统一入口（`openviking/client.py`、`sync_client.py`、`async_client.py`，以及 SDK）。
- **Service 层**（`openviking/service/`）：FSService、SearchService、SessionService、ResourceService、RelationService、PackService、DebugService。设计目的是让 HTTP Server 与 CLI 复用同一套业务逻辑。
- **Retrieve**：IntentAnalyzer（意图分析）、HierarchicalRetriever（分层检索）、Rerank。
- **Session**：消息记录、usage 跟踪、压缩、记忆提交。
- **Parse**：文档解析（PDF/MD/HTML/代码/图像/音视频）、TreeBuilder、异步语义生成。
- **Compressor**：schema 驱动的记忆提取 + LLM 去重决策。
- **Storage**：VikingFS（URI 抽象）+ AGFS/RAGFS（内容存储）+ Vector Index（索引）。

### 3.2 数据流

- **写路径**：`Input → Parser → TreeBuilder → AGFS → SemanticQueue → Vector Index`
  - Parser 不做任何 LLM 调用（解析与语义解耦）；语义生成全部异步。
- **读路径**：`Query → Intent Analysis → Hierarchical Retrieval → Rerank → Results`
- **会话提交**：`Messages → Compress → Archive → Memory Extraction → Storage`

### 3.3 部署形态（`01-architecture.md`）

- **Embedded 模式**：`client = OpenViking(path="./data")`，单进程本地用，自动拉起 AGFS 子进程。
- **HTTP 模式**：`openviking-server` 独立进程，`SyncHTTPClient(url="http://localhost:1933", api_key=...)`，任何语言可通过 HTTP API 接入。
- Docker 镜像（ghcr.io/volcengine/openviking，默认同时起 server + vikingbot + web studio），helm 部署（`deploy/helm`）。

### 3.4 viking:// URI 协议（`docs/en/concepts/04-viking-uri.md`）

- scope 体系：`resources`（账号级共享知识）、`user`（当前用户数据，含 sessions）、`agent`（账号级共享 Agent 能力：skills/endpoints/tools/payments）；`temp`、`queue`、`upload` 为内部 scope，不可对外寻址。
- 目录布局：
  ```
  viking://
  ├── resources/{project}/          # 共享资源
  ├── agent/skills/...              # 账号级共享技能（全局）
  └── user/{user_id}/
      ├── profile.md
      ├── memories/{preferences,entities,events,profile,identity,soul,cases,trajectories,experiences,tools,skills}
      ├── resources/                # 用户私有资源
      ├── skills/
      ├── peers/{peer_id}/{memories,resources}
      └── sessions/{session_id}/{messages.jsonl,tools,history}
  ```
- **路径变量**：`{namespace:key}`，如 `{calendar:today}` → `2026/05/07`，服务端渲染。适合邮件/日志/日报等时序数据组织。
- 特殊文件：`.abstract.md`（L0）、`.overview.md`（L1）、`.relations.json`（关联）、`.meta.json`。

### 3.5 HTTP Server（`openviking/server/`）

- FastAPI app，路由见 `openviking/server/routers/`：admin、bot、console、content、debug、filesystem、metrics、observer、pack、privacy_configs、relations、resources、search、sessions、skills、snapshot、stats、system、tasks、user_settings、watches、**webdav**（`/webdav/resources`，把 resources scope 暴露为 WebDAV！可用 PROPFIND/PUT/GET 等操作）。
- **MCP 端点**：`openviking/server/mcp_endpoint.py`，`/mcp` 暴露 find、search、read、list、remember、add_resource、grep、glob、forget、health 等工具，支持 Claude Code/Trae/Cursor/OpenCode 等，认证复用 X-API-Key。
- 多租户认证：`api_key` 模式 / `trusted` 模式（上游网关注入 X-OpenViking-Account/User），ROOT/ADMIN/USER 三级角色（`docs/en/concepts/11-multi-tenant.md`）。

### 3.6 Client CLI（`ov`）

- Rust 实现（`crates/ov_cli/`），命令模块（`crates/ov_cli/src/commands/`）：filesystem（ls/tree）、search（find/search）、resources、skills、session、relations、pack、privacy、crypto、snapshot、system、task、watch、admin、compile、chat、observer。
- 常用命令示例（README）：
  ```bash
  ov status
  ov add-resource <url>
  ov ls viking://resources/
  ov tree viking://resources/volcengine -L 2
  ov find "what is openviking"
  ov grep "openviking" --uri ...
  ```
- `ov compile`：把一组 URI 按一个 Skill 编译成上下文产物（异步任务，`/bot/v1/compile`）。

### 3.7 OpenViking Studio / OpenViking Helper / VikingBot

- **OpenViking Studio**：浏览器端的 live demo/playground（`openviking.ai/studio`），官方镜像/`openviking-server` 在 `/studio` 内置。
- **OpenViking Helper（Beta）**：桌面控制台（macOS/Windows），可视化配置 agent 插件、解析 session trace、管理本地记忆/SKILL.md。
- **VikingBot**：基于 OpenViking 的多通道 AI agent 框架（`bot/`），支持飞书/Slack/Telegram/QQ/钉钉，`ov chat` 入口；包含 agent loop、tool registry、skills、sandbox（Direct/SRT/OpenSandbox）、定时任务等。

### 3.8 Agent 集成

- Claude Code、Codex、OpenClaw、Hermes、Cursor、Trae、OpenCode、pi、MCP clients、LangChain/LangGraph（`examples/` 下各有插件，如 `examples/opencode-plugin/`、`examples/openclaw-plugin/`）。
- 集成模式：插件负责两件事——(1) 在 agent 上下文注入 OpenViking 召回（recall）；(2) 自动 commit 会话记忆。OpenClaw 插件是最完整的（`examples/openclaw-plugin/`：context-engine、recall-trace、session lifecycle、memory tools 等）。

---

## 4. 记忆核心实现（重点）

### 4.1 写路径：内容 → L0/L1/L2

- **Parser**（`openviking/parse/`）：格式解析，无 LLM；支持 markdown/text/pdf/html/代码仓库（尊重 .gitignore）/图像/视频/音频。
  - 智能切分（`docs/en/concepts/06-extraction.md`）：`document_tokens <= 1024` 存单文件；否则按标题切分，<512 token 的小节合并，>1024 token 的小节建子目录。
- **TreeBuilder**（`openviking/parse/tree_builder.py`）：把 temp 目录整体搬到 AGFS，再入队 SemanticQueue。
- **SemanticQueue**（异步，自底向上）：对每个目录并发生成文件摘要（限 10 并发）→ 收集子目录 .abstract → 生成 .overview（LLM）→ 抽取 .abstract → 写回 AGFS → 向量化入 EmbeddingQueue。
- 目录结构（`03-context-layers.md`）：
  ```
  viking://resources/docs/auth/
  ├── .abstract.md      # L0
  ├── .overview.md      # L1
  ├── .relations.json
  ├── oauth.md          # L2
  └── ...
  ```

### 4.2 存储层（`docs/en/concepts/05-storage.md` + `openviking/storage/viking_fs.py`）

- **双层存储**：内容全部在 AGFS（Rust RAGFS 实现），向量索引只存 URI/向量/元数据，不存文件内容。
  - 好处：单数据源（内容只读 AGFS）、内存优化、可独立扩展。
- **VikingFS**（`openviking/storage/viking_fs.py`）：URI 抽象层，提供 read/write/mkdir/rm/mv/abstract/overview/relations/find。
  - URI 映射：`viking://resources/docs/auth → /local/{account_id}/resources/docs/auth`。
  - 向量同步：`rm` 自动删索引前缀；`mv` 自动更新 uri/parent_uri。
- **AGFS/RAGFS**：POSIX 风格文件操作，插件式文件系统（`crates/ragfs/src/plugins/`：localfs、s3fs、memfs、kvfs、sqlfs、queuefs、serverinfofs），radix-trie 路由（MountableFS）。
  - 支持多写模式（primary + backups，`.redirect.json`/`.sync_log.json` 追踪），多后端：localfs/s3fs/memory。
  - `crates/ragfs/src/git/`：基于 gitoxide 的 in-process Git 集成设计（`docs/design/git-version-control-design.md`），按 account 粒度做 commit/restore/show 快照回滚。
- **向量索引**（`openviking/storage/vectordb/`）：本地 C++ 引擎（flat_hybrid 混合索引、cosine、int8 量化）+ vikingdb（Volcengine）+ cuVS（NVIDIA GPU）+ 本地 ollama embed 等适配器。

### 4.3 session commit → 记忆提取管线

- `openviking/session/session.py` 的 `commit_async()`（第 1675 行起）分两个阶段：
  - **Phase 1（同步，立即返回）**：消息切分成 archive/retain 两部分，写 archive 原始消息，入队 Phase 2，返回 `task_id`。
  - **Phase 2（异步后台，`_run_memory_extraction`，第 2192 行起）**：生成结构化摘要 → 写 `.abstract.md`/`.overview.md` → **提取长期记忆** → 写 `memory_diff.json`（审计/回滚）→ 更新 active_count → 写 `.done` 标记。
- 两个记忆步（`_MEMORY_STEP_NAMES = ("long_term", "execution")`）：
  1. **long_term**：用户偏好/画像/实体/事件等（self + peer，受 memory_policy 控制）
  2. **execution**：trajectories（轨迹）、experiences（经验）、session skills（agent 学习）
- **MemoryPolicy**（`openviking/session/memory_policy.py`）：`{self:{enabled}, peer:{enabled}, memory_types:[...], working_memory:{enabled}}`。
- **提取流程**（`docs/en/concepts/08-session.md` + `docs/design/session-memory-extraction-flow.md`）：
  ```
  Messages → LLM Extract → Candidate Memories
              → Vector Pre-filter → Find Similar Memories
              → LLM Dedup Decision → candidate(skip/create/none) + item(merge/delete)
              → Write to AGFS → Vectorize
  ```
  - 去重决策分两级：candidate 级（skip/create/none）与 item 级（merge/delete）。
- **ExtractLoop**（`openviking/session/memory/extract_loop.py`）：简化 ReAct 编排器——LLM 带工具（read/write/search 等）自主决定是继续查还是输出最终 operations JSON；最多 3 轮迭代；失败容忍（格式错误重试 1 次、末轮解析失败按"无操作"处理）。
- **MemoryUpdater**（`openviking/session/memory/memory_updater.py`）：系统执行器，把 LLM 最终输出写到 AGFS：upsert/delete、merge_op（immutable/patch 等）合并、links/backlinks 双向关系、page_id 映射、版本号递增、重向量化、重建目录 overview。
- **schema 驱动**：每种记忆类型是 YAML schema（`openviking/prompts/templates/memory/*.yaml`），定义字段、merge_op、文件名模板、embedding 模板、overview 模板。例如 `preferences.yaml`：`directory: viking://user/{{user_space}}/memories/preferences`，`filename_template: {{user}}/{{topic}}.md`，topic 字段 `merge_op: immutable`，content 字段 `merge_op: patch`。
  - `trajectories.yaml` 设计得极其精细：`operation_mode: add_only`、`stage: agent`，content 是严格的"操作契约"模板（Trigger/Procedure/Applicability Boundary/Write Field Provenance 等 11 个标签），retrieval_anchor 专门为 embedding 而写。
- **memory_diff.json**：每次 commit 记录 adds/updates/deletes，支持审计与回滚（`08-session.md` 有完整 JSON 示例）。
- **Agent 经验/轨迹记忆**：
  - `agent_trajectory_context_provider.py`：从任务 rollout 提取可复用轨迹。
  - `agent_experience_context_provider.py`：给定新轨迹摘要，检索候选 experiences（top-5，前 3 附 source_trajectories），LLM 决定更新已有经验/新建/不动作。
  - `openviking/session/train/`：完整的 "session train" 框架（trajectory analysis → gradient estimation → policy optimization），支持多轮 self-improvement 训练（tau2 实验用的就是它）。

### 4.4 检索轨迹的可观测性

- `HierarchicalRetriever.retrieve()` 返回 `QueryResult(query, matched_contexts, searched_directories)`——**searched_directories 就是本次检索实际下钻过的目录列表**。
- `FindResult` 含 `query_plan`（search 时）与 `query_results`。
- `ov observer`（`crates/ov_cli/src/commands/observer.rs` → `/api/v1/observer/retrieval`）可看检索统计表（total queries / zero-result rate / avg score / latency / rerank 使用情况）。
- `RetrievalStatsCollector`（`openviking/retrieve/retrieval_stats.py`）线程安全地累计每条 query 的指标。
- telemetry：opentelemetry + 日志 tracer，session commit 每个阶段有 trace_id，rollout/train 事件流可 tail 调试（`benchmark/tau2/` 说明）。
- 但"目录浏览轨迹"的粒度主要是"进入过哪些目录"，尚未看到把每一步下钻路径完整序列化给用户 UI 的代码；README 的"you can see exactly which path produced it"更接近 `searched_directories` + query_plan + observer 统计的组合。

---

## 5. 检索算法

### 5.1 两阶段：find vs search（`docs/en/concepts/07-retrieval.md`）

| 特性 | find() | search() |
|---|---|---|
| 会话上下文 | 不需要 | 需要 |
| 意图分析 | 不用 | LLM 分析（0-5 个 TypedQuery） |
| 延迟 | 低 | 高 |
| 用途 | 简单查询 | 复杂任务 |

### 5.2 意图分析（IntentAnalyzer，`openviking/retrieve/intent_analyzer.py`）

- 输入：会话压缩摘要 + 最近 5 条消息 + 当前 query；输出 0-5 个 TypedQuery（query/context_type/intent/priority）。
- 查询风格：skill 用动词开头（"Create RFC document"）、resource 用名词短语、memory 用 "User's XX"。
- query_planner 可单独配置（可用轻量微调模型 ollama 的 `ov_intent_analysis_sft`），fallback 到 vlm。

### 5.3 目录递归检索（HierarchicalRetriever，`openviking/retrieve/hierarchical_retriever.py`）

算法核心（THINKING 模式）：
1. 按 context_type 确定根目录（MEMORY→`viking://user/memories`、RESOURCE→`viking://resources`、SKILL→`viking://user/skills`）。
2. **全局向量检索**定位起始目录（GLOBAL_SEARCH_TOPK=10，只在 level 0/1 上检索）。
3. 起始点合并 + rerank（若有配置）。
4. **递归下钻**：优先级队列（按分数）弹目录 → 搜子节点 → 每个结果的最终分 = `alpha * embedding_score + (1-alpha) * parent_score`（`score_propagation_alpha` 默认 1.0，即只用自己的分）→ 超过阈值则收集，且非叶子（level 0/1）继续入队递归。
5. 收敛检测：topk 连续 3 轮不变或池不再增长就停（MAX_CONVERGENCE_ROUNDS=3）。
6. 只下钻 level 0/1（L2 文件是终点命中）。

- 关键常量（`hierarchical_retriever.py` 第 53-58 行）：
  - `MAX_CONVERGENCE_ROUNDS = 3`
  - `MAX_RELATIONS = 5`
  - `DIRECTORY_DOMINANCE_RATIO = 1.2`（目录分须超过最大子分，否则作为叶子处理）
  - `GLOBAL_SEARCH_TOPK = 10`
  - `MAX_PARALLEL_CHILD_SEARCHES = 4`（限制对远端向量库的扇出）
- **hotness 混合**（`openviking/retrieve/memory_lifecycle.py`）：`hotness = sigmoid(log1p(active_count)) * exp(-decay*age)`（半衰期默认 7 天），与语义分按 `hotness_alpha` 混合，让高频/新近使用的记忆上浮。这就是冷热记忆生命周期管理。
- **rerank**：THINKING 模式下用 doubao-seed-rerank 对每个层级的候选重新打分；失败自动回退到向量分。
- **QUICK 模式**：单次向量检索 + 阈值过滤，不递归。

### 5.4 结果带上下文

- MatchedContext 返回 uri/context_type/level/abstract/score/relations；结果 URI 会按 level 附上 `.abstract.md` 或 `.overview.md` 后缀（`_append_level_suffix`），即返回的是"可立即判断相关性"的 L0/L1 文本，而不是把整份 L2 塞进上下文。
- 目录本身也是候选（level 0/1），所以检索结果天然带目录上下文。

---

## 6. 团队 / 多用户能力

### 6.1 多租户模型（`docs/en/concepts/11-multi-tenant.md`）

- 单实例内用 `account`（租户外层）+ `user`（租户内用户）双边界控制共享与隔离：
  - account 之间完全隔离；account 内 `viking://resources` 共享；user 的记忆/session 隔离。
  - 角色：ROOT（全局）/ ADMIN（单账号）/ USER（单账号单用户）。
- 存储层自动加 account 前缀：`viking://user/alice/memories → /local/{account_id}/user/alice/memories`。
- 认证：`api_key`（root key 或 user key）/ `trusted`（上游注入 header）。无 root_api_key = dev 模式，仅限 localhost。

### 6.2 用户/Peer 隔离

- 目录布局天然支持：`viking://user/{user_id}/memories/`（self）、`viking://user/{user_id}/peers/{peer_id}/memories/`（对某个交互对象的记忆）、`.../peers/{peer_id}/resources/`。
- Peer 是"交互对象"（如 web 访客），不是租户；`X-OpenViking-Actor-Peer` 可把检索/filesystem 视野限制到某个 peer。
- identity 路径段必须是安全单段（如 `alice`、`web-visitor-alice`）。

### 6.3 多 agent 共享

- `viking://agent/` scope 是账号级全局共享（skills/endpoints/tools/payments），所有用户可见。
- 每个 agent（集成插件）以 user 身份写入自己的 user 空间；同账号共享 resources。
- OpenClaw 插件是"一个实例一个 user key"模型；VikingBot 是"平台用 root key 管理大量终端用户"模型（bot 自动注册用户、缓存 user key）。

### 6.4 资源与技能的组织

- 共享资源：`viking://resources/{project}/docs/...`（账号级）
- 用户私有资源：`viking://user/{user_id}/resources/`
- 技能默认在 `viking://user/skills/{name}/`，可用 `-p viking://agent/skills` 覆盖到全局。

---

## 7. 数据支撑（Benchmark）

### 7.1 来源

- **README.md**（第 93-103 行）：LoCoMo 与 tau2-bench 主数字。
- **Blog benchmark 报告**：`https://blog.openviking.ai/post/openviking-benchmark-results/`（2026-05-29 更新，含 ClawWork、HotpotQA、单轮 RAG 对比）。
- **论文**：VikingMem（arXiv:2605.29640），本文只读到引用，无全文数据可核。
- **复现脚本**：`benchmark/` 目录（locomo / tau2 / RAG / longmemeval / skillsbench / retrieval / vectordb_perf / cuvs / custom）。

### 7.2 LoCoMo（长期对话用户记忆）

| 集成 | 原生准确率 | +OpenViking | 平均查询时间 | 输入 token |
|---|---|---|---|---|
| OpenClaw native memory | 24.20% | **82.08%** | 95.14s → 38.8s | 392.6M → 37.4M |
| Hermes native memory | 33.38% | **82.86%** | 82.4s → 27.9s | 79.2M → 52.0M |
| Claude Code auto-memory | 57.21% | **80.32%** | 49.1s → 20.4s | 353.3M → 130.0M |

- 效率：延迟下降 58.45%–66.10%；token 下降 34.3%–91.0%（OpenClaw -91.0%、Hermes -34.3%、Claude Code -63.2%）。
- README 的对应表述："all three agent integrations land at 80–83% accuracy ... input tokens drop by 34.3–91.0% and query latency by 58.45–66.10%"。

### 7.3 tau2-bench（Agent 经验记忆）

| 设定 | Retail 任务成功率 | Airline 任务成功率 |
|---|---|---|
| LLM 无记忆 | 70.94% | 54.38% |
| LLM + OpenViking 经验记忆 | **77.81% (+6.87pp)** | **66.25% (+11.87pp)** |

- 复现协议（`benchmark/tau2/vikingbot/README.md`）：只用 **train split** 提取记忆，test split 隔离评估（无泄漏）；每 epoch train 1 次 + test 8 次取平均；"cold start → memory-augmented"多轮自改进。
- `benchmark/tau2/llm/` 用原生 ReAct agent + OpenViking 记忆（template-indexed trajectory top4 prewrite top2）。

### 7.4 附加数据（blog，同报告）

- **ClawWork**：净收入 50 任务 $2,269.77 → $3,843.74（+69.34%）；每小时 token 1,030.3K → 872.4K（-22.8%）。
- **HotpotQA**：OpenViking top-20 检索准确率 91.00%，检索延迟 0.23s（对比 Naive RAG 62.50%/0.11s、LightRAG 89%/75s、HippoRAG 2 61%/20s）。
- **单轮 RAG 平均**（FinanceBench/NQ/ClapNQ/Qasper/SyllabusQA）：OpenViking 66.87% 平均准确率、0.19s 检索延迟、索引 token 8.67M（约为 LightRAG 的 13.8%）。

### 7.5 口径注意点（诚实评估）

- 三个 agent 的"原生记忆"基准本身差异很大（24%/33%/57%），因为原生记忆机制不同（OpenClaw/Hermes 原生记忆弱、Claude Code auto-memory 较强）。OpenViking 统一拉平到 80-83%，说明其上下文集注入机制与三者都兼容。
- token/延迟数字来自官方博客，未提供第三方独立复现报告（仓库只给脚本）。
- tau2 对比对象是"无记忆的 LLM"，不是与其他记忆系统的横向对比。
- LoCoMo 用 LLM 裁判（judge.py）打分（默认 doubao-seed-2-0-pro）。

---

## 8. 优点（独到设计）

1. **文件系统心智模型 + 确定性定位**：把记忆/资源/技能统一成 `viking://` 文件树，agent 用 `ls/tree/find/grep` 就能操作自己的上下文，比纯黑盒向量库可解释、可控制、可调试。这对"团队项目记忆"这类需要人工组织/审查的场景尤其有价值。
2. **L0/L1/L2 分层加载省 token**：写入时一次性花成本做抽象/概览，读取时按需下钻；目录也带 L0/L1，相关性判断不用打开文件。benchmark 显示 token 最多降 91%。
3. **目录递归检索保留上下文**：先定位高分目录再逐层下钻，结果是"带着目录上下文的块"而不是孤立的碎片；配合 parent score 传播与收敛检测，质量与成本平衡。
4. **可观测检索轨迹**：每次检索记录 `searched_directories` + query_plan，`ov observer` 看整体质量指标，出错可定位到具体路径。
5. **schema 驱动的记忆类型系统**：记忆类型是 YAML 定义的（字段、merge_op、embedding 模板、文件名模板），可扩展可自定义；`merge_op: immutable/patch` 等让记忆更新语义化，配合 LLM 去重决策与 memory_diff 审计/回滚，形成"会自我迭代且可审计的记忆"。
6. **写读路径解耦 + 异步语义**：解析（无 LLM）与语义生成（异步队列）分离，commit 立即返回、后台提取，生产可用性强。
7. **技术纵深完整**：Rust（RAGFS）+ C++（向量引擎）+ Python（业务）+ PyO3 绑定、MCP 原生端点、WebDAV、gitoxide 版本快照、多写存储、NVIDIA cuVS GPU 检索、多语言 SDK、Docker/Helm 部署、开放遥测——工程化程度在同类开源项目里相当高。
8. **多租户即第一公民**：account/user/peer 三级身份在存储层自动加前缀，一套服务服务多团队/多用户，天然适合团队场景。

---

## 9. 缺点 / 局限（诚实评估）

1. **成熟度仍为 Alpha/0.x**：classifier 是 "3 - Alpha"；URI scope 语义在 0.3.x→0.4.x 间发生过破坏性变化（`viking://session` → `viking://user/{id}/sessions`，遗留只读兼容层）；文档与代码存在不一致（如 `crates/ov_cli/Cargo.toml` 写 MIT，README/crates/LICENSE 写 Apache 2.0）。
2. **AGPLv3 对商用是硬约束**：主项目 AGPL 意味着只要以网络形式提供服务就要开源修改后的完整代码；对想闭源集成的企业是明显障碍。官方因此另做托管服务（VikingDB）与企业版——开源版本质上是引流/共建渠道。
3. **基准口径需谨慎**：
   - 无第三方独立复现；数字全部来自官方博客+脚本。
   - 基线选择（native memory vs no memory）直接影响提升幅度表述；LoCoMo 三 agent 原生基线差异大。
   - tau2 只对比"无记忆 LLM"，没对比 mem0/supermemory 等其他记忆系统（LoCoMo 目录下虽有 mem0/supermemory 脚本，但 README 未给其对照结果）。
4. **LLM 依赖较重**：意图分析、L0/L1 生成、记忆提取/去重、rerank 全都依赖 LLM（还内置了 SFT 模型名作为 query_planner）。这意味着推理成本与延迟（虽然异步消化了一部分）、对模型质量的依赖，以及对 LLM 厂商 API 的绑定。私有化/离线部署门槛较高。
5. **实现深度参差**：检索"轨迹"可观测目前主要是 searched_directories + 统计表，尚未看到把每次下钻路径完整结构化为用户可视化轨迹的实现（README 的叙述略超前于代码）；`agent/endpoints|tools|payments` 等多数是 "planned"。
6. **记忆提取的"幻觉"风险**：用 LLM 从会话中提取偏好/经验并直接写入用户记忆空间，若提取错误会影响后续所有检索；虽有去重/审计/diff，但没有看到人工确认或回滚 UI 的默认工作流（VikingBot 这类自动化场景默认自动写）。
7. **Web Studio 等在 pip 包内分发**：`web_studio/dist` 作为 package-data，说明 web-studio 源码在仓库内相对精简（`openviking/web_studio/__init__.py` 只是占位），大部分是构建产物，独立二次开发不便。
8. **对国产/火山生态的倾向**：默认推荐 Volcengine Doubao 模型与 VikingDB 向量库，部分功能（rerank 后端、托管迁移）强绑定火山生态。

---

## 10. 可借鉴点（站在"团队项目记忆系统"角度）

1. **以"可寻址的文档树"组织记忆，而非扁平向量库**：团队记忆天然按项目/主题/成员/时间组织，`viking://` 式的确定性路径 + 标准文件操作（ls/tree/grep）心智负担低、可审计、可人工整理，值得直接借鉴。
2. **写入时分层（L0/L1/L2）而非读取时压缩**：把"摘要/概览/全文"作为一等公民在写入管线里异步生成，检索和注入上下文时按需取层，是省 token 的关键工程手段，团队记忆量大时收益显著。
3. **目录级检索 + 下钻保留上下文**：先定位目录再深入，让召回结果带语境，避免"检索到一句话但不知道属于哪块"的老问题——团队 Wiki/代码库检索特别需要。
4. **schema 化记忆类型 + merge_op 语义更新**：把"记忆是什么、字段怎么合并"声明成 schema，让 LLM 提取输出受控，且更新有明确语义（immutable/patch/merge），比直接 append 日志或自由文本更稳。
5. **记忆变更审计（memory_diff）**：每次 commit 记录 adds/updates/deletes，可回滚可追溯。对团队场景（多成员共享记忆）几乎是必须的。
6. **异步、可重试、可观测的记忆提取管线**：commit 立即返回、后台带重试（指数退避）跑提取，用任务系统追踪，任何一步失败不阻塞主链路；配合 trace_id 贯穿。这是生产级记忆系统的工程底线。
7. **身份边界前置到存储层**：account/user/peer 在 URI 解析时就带前缀，隔离在存储层强制而非在业务层自觉——团队系统里"我该看到什么"应该由架构保证。
8. **以 MCP/插件形式无缝接入现有 agent 生态**：内置 MCP 端点 + 各 agent 插件（Claude Code/OpenCode/OpenClaw），把记忆能力暴露成标准工具（find/remember/read），接入成本低。
9. **可借鉴但需谨慎的点**：LLM 自动提取的信任边界（建议加人工确认或低置信降级）；AGPL 授权策略（如果想开源共建就用强 copyleft，但要想清楚商用约束）；对单一云厂商的绑定要评估是否可替换（它的 embedding/rerank/向量库都有抽象层，这一点其实也值得学——provider 抽象做得不错）。

---

## 附：关键代码/文档索引

- 架构总览：`docs/en/concepts/01-architecture.md`
- 上下文类型 / 分层 / URI：`docs/en/concepts/02/03/04-*.md`
- 存储：`docs/en/concepts/05-storage.md`；实现 `openviking/storage/viking_fs.py`、`crates/ragfs/`
- 提取：`docs/en/concepts/06-extraction.md`；实现 `openviking/parse/`、`openviking/session/memory/`
- 检索：`docs/en/concepts/07-retrieval.md`；实现 `openviking/retrieve/hierarchical_retriever.py`、`intent_analyzer.py`
- 会话：`docs/en/concepts/08-session.md`；实现 `openviking/session/session.py`（commit_async 第 1675 行、_run_memory_extraction 第 2192 行）
- 记忆 schema：`openviking/prompts/templates/memory/*.yaml`
- 多租户：`docs/en/concepts/11-multi-tenant.md`
- 基准：`benchmark/locomo/README.md`、`benchmark/tau2/*/README.md`、`benchmark/RAG/`
- 博客基准报告：`https://blog.openviking.ai/post/openviking-benchmark-results/`
- 论文：VikingMem，arXiv:2605.29640（VLDB 2026）
- 版本历史：`docs/en/about/02-changelog.md`、`RELEASE.md`
